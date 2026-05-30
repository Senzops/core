import cron from 'node-cron';
import tls from 'tls';
import { URL } from 'url';
import axios from 'axios';
import { Monitor, MonitorRun, MonitorIncident } from '../models/Monitor';
import { logger } from '../utils/logger';

const BATCH_SIZE = 50;
const TIMEOUT_MS = 10000;
const SSL_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export const startUptimeWorker = () => {
  logger.info('[Worker] Uptime Monitor Service Started (Isolated Process)');

  cron.schedule('* * * * *', async () => {
    logger.info('[Worker] Starting Full Sweep...');
    await runFullSweep();
  }, { name: "uptime-monitoring-schedule" });

  cron.schedule('*/5 * * * *', async () => {
    await releaseStuckLocks();
  }, { name: "uptime-self-healing" });
};

const runFullSweep = async () => {
  let hasMore = true;
  let processedCount = 0;

  while (hasMore) {
    const now = new Date();
    const candidates = await Monitor.find({
      nextCheck: { $lte: now },
      isLocked: false,
    }).limit(BATCH_SIZE);

    if (candidates.length === 0) {
      hasMore = false;
      break;
    }

    const promises = candidates.map(async (monitor) => {
      const lockedMonitor = await Monitor.findOneAndUpdate(
        { _id: monitor._id, isLocked: false },
        { isLocked: true, lockTime: now }
      );

      if (!lockedMonitor) return;

      await performCheck(lockedMonitor);
    });

    await Promise.all(promises);
    processedCount += candidates.length;

    await new Promise(r => setTimeout(r, 100));
  }

  if (processedCount > 0) {
    logger.info(`[Worker] Sweep Complete. Processed ${processedCount} monitors.`);
  }
};

const performCheck = async (monitor: any) => {
  const start = Date.now();
  let status: 'up' | 'down' | 'timeout' = 'down';
  let statusCode = 0;
  let latency = 0;

  const method = (monitor.method || 'GET').toLowerCase();
  const headers = monitor.headers && typeof monitor.headers === 'object' ? monitor.headers : {};
  const expectedStatus = monitor.expectedStatus || 0;
  const body = monitor.body || undefined;

  try {
    const res = await axios({
      method,
      url: monitor.url,
      timeout: TIMEOUT_MS,
      headers,
      data: method !== 'get' && method !== 'head' ? body : undefined,
      validateStatus: () => true,
      maxRedirects: 5,
    });

    latency = Date.now() - start;
    statusCode = res.status;

    if (expectedStatus > 0) {
      status = res.status === expectedStatus ? 'up' : 'down';
    } else {
      status = (res.status >= 200 && res.status < 300) ? 'up' : 'down';
    }

  } catch (error: any) {
    latency = Date.now() - start;
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      status = 'timeout';
      statusCode = 408;
    } else {
      status = 'down';
      statusCode = error.response?.status || 0;
    }
  }

  await MonitorRun.create({ monitorId: monitor._id, status, latency, statusCode });

  const previousStatus = monitor.status;
  const updateFields: Record<string, any> = {
    status,
    lastCheck: new Date(),
    nextCheck: new Date(Date.now() + monitor.interval * 60 * 1000),
    isLocked: false,
    lockTime: null,
  };

  // lastDownAt marks the start of the current uptime streak (set on recovery)
  if (status === 'up' && previousStatus !== 'up' && previousStatus !== 'pending') {
    updateFields.lastDownAt = new Date();
  }

  await Monitor.findByIdAndUpdate(monitor._id, updateFields);

  // --- Incident management ---
  try {
    if (status !== 'up' && (previousStatus === 'up' || previousStatus === 'pending')) {
      await MonitorIncident.create({
        monitorId: monitor._id,
        ownerId: monitor.ownerId,
        startedAt: new Date(),
        cause: status,
        statusCode,
      });
    } else if (status === 'up' && previousStatus !== 'up' && previousStatus !== 'pending') {
      const openIncident = await MonitorIncident.findOne({
        monitorId: monitor._id,
        resolvedAt: null,
      }).sort({ startedAt: -1 });

      if (openIncident) {
        const duration = Date.now() - new Date(openIncident.startedAt).getTime();
        await MonitorIncident.findByIdAndUpdate(openIncident._id, {
          resolvedAt: new Date(),
          duration,
        });
      }
    }
  } catch (err: any) {
    logger.error(`[Worker] Incident tracking error for ${monitor._id}: ${err.message}`);
  }

  // --- SSL certificate check (once per hour) ---
  try {
    const parsedUrl = new URL(monitor.url);
    if (parsedUrl.protocol === 'https:') {
      const lastSslCheck = monitor.ssl?.lastCheckedAt;
      const shouldCheckSsl = !lastSslCheck || (Date.now() - new Date(lastSslCheck).getTime() > SSL_CHECK_INTERVAL_MS);

      if (shouldCheckSsl) {
        const sslInfo = await probeSslCertificate(parsedUrl.hostname, Number(parsedUrl.port) || 443);
        await Monitor.findByIdAndUpdate(monitor._id, { ssl: sslInfo });
      }
    }
  } catch (err: any) {
    logger.error(`[Worker] SSL probe error for ${monitor._id}: ${err.message}`);
  }
};

const probeSslCertificate = (hostname: string, port: number): Promise<any> => {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: hostname, port, servername: hostname, rejectUnauthorized: false, timeout: 5000 }, () => {
      try {
        const cert = socket.getPeerCertificate();
        const protocol = socket.getProtocol() || '';

        if (!cert || !cert.valid_from) {
          socket.destroy();
          return resolve({
            valid: false,
            issuer: '',
            subject: '',
            validFrom: null,
            validTo: null,
            daysRemaining: -1,
            protocol,
            lastCheckedAt: new Date(),
            error: 'No certificate presented',
          });
        }

        const validFrom = new Date(cert.valid_from);
        const validTo = new Date(cert.valid_to);
        const now = new Date();
        const daysRemaining = Math.floor((validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

        const issuerParts = cert.issuer;
        const issuerStr = typeof issuerParts === 'object'
          ? (issuerParts.O || issuerParts.CN || JSON.stringify(issuerParts))
          : String(issuerParts);

        const subjectParts = cert.subject;
        const subjectStr = typeof subjectParts === 'object'
          ? (subjectParts.CN || JSON.stringify(subjectParts))
          : String(subjectParts);

        socket.destroy();

        resolve({
          valid: now >= validFrom && now <= validTo,
          issuer: issuerStr,
          subject: subjectStr,
          validFrom,
          validTo,
          daysRemaining,
          protocol,
          lastCheckedAt: new Date(),
          error: null,
        });
      } catch (err: any) {
        socket.destroy();
        resolve({
          valid: false,
          issuer: '',
          subject: '',
          validFrom: null,
          validTo: null,
          daysRemaining: -1,
          protocol: '',
          lastCheckedAt: new Date(),
          error: err.message,
        });
      }
    });

    socket.on('error', (err) => {
      socket.destroy();
      resolve({
        valid: false,
        issuer: '',
        subject: '',
        validFrom: null,
        validTo: null,
        daysRemaining: -1,
        protocol: '',
        lastCheckedAt: new Date(),
        error: err.message,
      });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({
        valid: false,
        issuer: '',
        subject: '',
        validFrom: null,
        validTo: null,
        daysRemaining: -1,
        protocol: '',
        lastCheckedAt: new Date(),
        error: 'Connection timed out',
      });
    });
  });
};

const releaseStuckLocks = async () => {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);
  const result = await Monitor.updateMany(
    { isLocked: true, lockTime: { $lt: cutoff } },
    { isLocked: false, lockTime: null }
  );
  if (result.modifiedCount > 0) {
    logger.warn(`[Worker] Auto-released ${result.modifiedCount} stuck locks.`);
  }
};
