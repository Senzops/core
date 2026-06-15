import cron from 'node-cron';
import os from 'os';
import { Vps, VpsRun } from '../models/Vps';
import { SystemLock } from '../models/Task';
import { logger } from '../utils/logger';
import { getRetentionMs } from '../services/retentionCache';

const WORKER_ID = `heartbeat-${os.hostname()}-${process.pid}`;
const LOCK_NAME = 'vps-heartbeat-sweep';
const LOCK_TTL_MS = 55 * 1000;

const STALENESS_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes — tolerates 1 missed heartbeat

const EMPTY_HEARTBEAT_METRICS = {
  _heartbeat: 'miss' as const,
  cpu: { usagePercent: 0, cores: 0, brand: '' },
  memory: { used: 0, total: 0, free: 0, active: 0, usagePercent: 0 },
  disk: [],
  hardware: { temperature: 0, powerDraw: 0 },
  gpus: [],
  network: { bytesRecvSec: 0, bytesSentSec: 0, latencyMs: 0 },
  processes: { running: 0, sleeping: 0, blocked: 0, total: 0 },
  uptimeSeconds: 0,
  docker: [],
  nginx: null,
  traefik: null,
};

export const runHeartbeatSweep = async () => {
  const now = new Date();

  // Distributed lock — only one instance runs at a time
  try {
    await SystemLock.findOneAndUpdate(
      { lockName: LOCK_NAME },
      { $set: { lockedAt: now, lockedBy: WORKER_ID, expiresAt: new Date(now.getTime() + LOCK_TTL_MS) } },
      { upsert: true, new: true, rawResult: true }
    );
  } catch (lockError: any) {
    if (lockError.code === 11000) return;
    throw lockError;
  }

  try {
    const staleThreshold = new Date(now.getTime() - STALENESS_THRESHOLD_MS);

    // Find all VPS that were active at some point but stopped reporting
    const staleServers = await Vps.find({
      lastSeen: { $ne: null, $lt: staleThreshold },
    }).select('_id status ownerId').lean();

    if (staleServers.length === 0) return;

    // Transition online → offline
    const onlineToOffline = staleServers.filter(s => s.status === 'online');
    if (onlineToOffline.length > 0) {
      const offlineIds = onlineToOffline.map(s => s._id);
      await Vps.updateMany(
        { _id: { $in: offlineIds } },
        { $set: { status: 'offline' } }
      );
      logger.info(`[Heartbeat] ${onlineToOffline.length} VPS transitioned to offline`);
    }

    // Insert synthetic heartbeat-miss records for all stale servers.
    // anchor: createdAt ≈ now; expiry resolved per-owner (cached).
    const nowMs = Date.now();
    const syntheticRuns = await Promise.all(
      staleServers.map(async (s) => ({
        vpsId: s._id,
        metrics: { ...EMPTY_HEARTBEAT_METRICS },
        expiresAt: new Date(nowMs + (await getRetentionMs(s.ownerId))),
      }))
    );

    await VpsRun.insertMany(syntheticRuns, { ordered: false });

  } catch (err: any) {
    logger.error(`[Heartbeat] Sweep error: ${err.message}`);
  } finally {
    await SystemLock.findOneAndDelete({ lockName: LOCK_NAME, lockedBy: WORKER_ID }).catch(() => {});
  }
};

export const startHeartbeatWorker = () => {
  logger.info('[Worker] VPS Heartbeat Staleness Detector Scheduled');
  cron.schedule('* * * * *', async () => {
    try {
      await runHeartbeatSweep();
    } catch (error) {
      logger.error('[Worker] Heartbeat sweep unhandled exception:', error);
    }
  }, {
    name: 'senzor-vps-heartbeat',
    timezone: 'UTC',
  });
};
