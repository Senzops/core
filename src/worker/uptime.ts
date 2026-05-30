import cron from 'node-cron';
import tls from 'tls';
import { URL } from 'url';
import axios from 'axios';
import { Monitor, MonitorRun, MonitorIncident } from '../models/Monitor';
import { logger } from '../utils/logger';

const BATCH_SIZE = 50;
const TIMEOUT_MS = 10000;
const SSL_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DOMAIN_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

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

  // --- Domain registration check (once per 24 hours) ---
  try {
    const parsedUrl = new URL(monitor.url);
    const lastDomainCheck = monitor.domain?.lastCheckedAt;
    const shouldCheckDomain = !lastDomainCheck || (Date.now() - new Date(lastDomainCheck).getTime() > DOMAIN_CHECK_INTERVAL_MS);

    if (shouldCheckDomain) {
      const domainInfo = await probeDomainRdap(parsedUrl.hostname);
      await Monitor.findByIdAndUpdate(monitor._id, { domain: domainInfo });
    }
  } catch (err: any) {
    logger.error(`[Worker] Domain RDAP probe error for ${monitor._id}: ${err.message}`);
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

// --- RDAP domain registration lookup ---

const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au',
  'co.nz', 'net.nz', 'org.nz',
  'co.za', 'org.za', 'web.za',
  'com.br', 'net.br', 'org.br',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp',
  'co.kr', 'or.kr', 'ne.kr',
  'co.in', 'net.in', 'org.in', 'gen.in',
  'com.cn', 'net.cn', 'org.cn',
  'com.mx', 'org.mx', 'net.mx',
  'com.ar', 'org.ar', 'net.ar',
  'com.sg', 'org.sg', 'net.sg', 'edu.sg',
  'com.hk', 'org.hk', 'net.hk',
  'com.tw', 'org.tw', 'net.tw',
  'co.th', 'or.th', 'in.th',
  'com.my', 'org.my', 'net.my',
  'com.ph', 'org.ph', 'net.ph',
  'com.pk', 'org.pk', 'net.pk',
  'com.ng', 'org.ng', 'net.ng',
  'com.eg', 'org.eg', 'net.eg',
  'com.tr', 'org.tr', 'net.tr',
  'com.ua', 'org.ua', 'net.ua',
  'com.vn', 'org.vn', 'net.vn',
  'co.id', 'or.id', 'web.id',
  'co.il', 'org.il', 'net.il',
  'com.pe', 'org.pe', 'net.pe',
  'com.co', 'org.co', 'net.co',
  'com.ec', 'org.ec', 'net.ec',
]);

const extractRegisteredDomain = (hostname: string): string => {
  const parts = hostname.toLowerCase().split('.');
  if (parts.length <= 2) return hostname.toLowerCase();

  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo) && parts.length > 2) {
    return parts.slice(-3).join('.');
  }

  return lastTwo;
};

const makeDomainError = (registeredDomain: string, error: string) => ({
  registeredDomain,
  registrar: '',
  expiresAt: null,
  registeredAt: null,
  daysRemaining: -1,
  nameServers: [],
  status: [],
  lastCheckedAt: new Date(),
  error,
});

const probeDomainRdap = async (hostname: string): Promise<any> => {
  const registeredDomain = extractRegisteredDomain(hostname);

  try {
    const res = await axios.get(`https://rdap.org/domain/${registeredDomain}`, {
      timeout: 10000,
      headers: { 'Accept': 'application/rdap+json, application/json' },
      validateStatus: () => true,
    });

    if (res.status !== 200) {
      return makeDomainError(registeredDomain, res.status === 404 ? 'Domain not found in RDAP' : `RDAP returned ${res.status}`);
    }

    const data = res.data;

    const events = Array.isArray(data.events) ? data.events : [];
    const expirationEvent = events.find((e: any) => e.eventAction === 'expiration');
    const registrationEvent = events.find((e: any) => e.eventAction === 'registration');

    const expiresAt = expirationEvent?.eventDate ? new Date(expirationEvent.eventDate) : null;
    const registeredAt = registrationEvent?.eventDate ? new Date(registrationEvent.eventDate) : null;

    const now = new Date();
    const daysRemaining = expiresAt
      ? Math.floor((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      : -1;

    let registrar = '';
    const entities = Array.isArray(data.entities) ? data.entities : [];
    for (const entity of entities) {
      const roles = Array.isArray(entity.roles) ? entity.roles : [];
      if (roles.includes('registrar')) {
        if (entity.vcardArray && Array.isArray(entity.vcardArray[1])) {
          const fnField = entity.vcardArray[1].find((f: any) => Array.isArray(f) && f[0] === 'fn');
          if (fnField) registrar = String(fnField[3] || '');
        }
        if (!registrar && entity.handle) registrar = String(entity.handle);
        break;
      }
    }

    const nameServers: string[] = [];
    if (Array.isArray(data.nameservers)) {
      for (const ns of data.nameservers.slice(0, 6)) {
        if (ns.ldhName) nameServers.push(String(ns.ldhName).toLowerCase());
      }
    }

    const status = Array.isArray(data.status) ? data.status.map(String).slice(0, 10) : [];

    return {
      registeredDomain,
      registrar,
      expiresAt,
      registeredAt,
      daysRemaining,
      nameServers,
      status,
      lastCheckedAt: new Date(),
      error: null,
    };
  } catch (err: any) {
    const message = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT'
      ? 'RDAP lookup timed out'
      : (err.message || 'RDAP lookup failed');
    return makeDomainError(registeredDomain, message);
  }
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
