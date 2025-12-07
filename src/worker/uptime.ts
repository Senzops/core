import cron from 'node-cron';
import axios from 'axios';
import { Monitor, MonitorRun } from '../models';
import { logger } from '../utils/logger';

const BATCH_SIZE = 50;
const TIMEOUT_MS = 5000;

export const startUptimeWorker = () => {
  logger.info('[Worker] Uptime Monitor Service Started (Isolated Process)');

  // Run every minute. This triggers the "Sweep".
  // The sweep will process ALL pending checks, whether there are 5 or 5000.
  cron.schedule('* * * * *', async () => {
    logger.info('[Worker] Starting Full Sweep...');
    await runFullSweep();
  });

  // Self-healing: Unlock stuck jobs every 5 mins
  cron.schedule('*/5 * * * *', async () => {
    await releaseStuckLocks();
  });
};

const runFullSweep = async () => {
  let hasMore = true;
  let processedCount = 0;

  while (hasMore) {
    // 1. Find a batch of pending jobs
    const now = new Date();
    const candidates = await Monitor.find({
      nextCheck: { $lte: now },
      isLocked: false,
    }).limit(BATCH_SIZE);

    if (candidates.length === 0) {
      hasMore = false;
      break;
    }

    // 2. Process concurrently
    const promises = candidates.map(async (monitor) => {
      // Atomic Lock
      const lockedMonitor = await Monitor.findOneAndUpdate(
        { _id: monitor._id, isLocked: false },
        { isLocked: true, lockTime: now }
      );

      if (!lockedMonitor) return; // Race condition handling

      await performCheck(lockedMonitor);
    });

    await Promise.all(promises);
    processedCount += candidates.length;

    // Tiny delay to let CPU breathe if loop is massive
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

  try {
    const res = await axios.get(monitor.url, {
      timeout: TIMEOUT_MS,
      validateStatus: () => true
    });

    const end = Date.now();
    latency = end - start;
    statusCode = res.status;

    if (res.status >= 200 && res.status < 300) status = 'up';
    else status = 'down';

  } catch (error: any) {
    const end = Date.now();
    latency = end - start;
    if (error.code === 'ECONNABORTED') {
      status = 'timeout';
      statusCode = 408;
    } else {
      status = 'down';
      statusCode = error.response?.status || 0;
    }
  }

  // Save Result
  await MonitorRun.create({ monitorId: monitor._id, status, latency, statusCode });

  // Reschedule
  const nextDate = new Date();
  nextDate.setMinutes(nextDate.getMinutes() + monitor.interval);

  await Monitor.findByIdAndUpdate(monitor._id, {
    status: status,
    lastCheck: new Date(),
    nextCheck: nextDate,
    isLocked: false,
    lockTime: null
  });
};

const releaseStuckLocks = async () => {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000); // 5 mins ago
  const result = await Monitor.updateMany(
    { isLocked: true, lockTime: { $lt: cutoff } },
    { isLocked: false, lockTime: null }
  );
  if (result.modifiedCount > 0) {
    logger.warn(`[Worker] Auto-released ${result.modifiedCount} stuck locks.`);
  }
};