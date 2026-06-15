import crypto from 'crypto';
import mongoose from 'mongoose';
import { Request, Response, NextFunction } from 'express';
import { Vps, VpsRun } from '../models/Vps';
import { RegisterVpsSchema, UpdateVpsSchema, TelemetrySchema } from '../utils/validation';
import { resolveTimeRange, getEffectiveRetention, fillTimeGapsWithStatus, TimeRangeError, type ResolvedTimeRange } from '../utils/timeRange';
import { logger } from '../utils/logger';
import { vpsIngestQueue, enqueue, type VpsIngestPayload } from '../lib/queue';
import { getRetentionMs } from '../services/retentionCache';

// --- VPS Controller ---

export const registerVps = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { email } = (req as any).user;
    const { name } = RegisterVpsSchema.parse(req.body);

    // Generate a secure API Key
    const apiKey = crypto.randomBytes(24).toString('hex');

    const newVps = await Vps.create({
      ownerId,
      name,
      apiKey, // Stored in DB. In strict prod, hash this. For now, returning it once.
      status: 'offline',
    });

    res.status(201).json({
      message: 'VPS Registered',
      vpsId: newVps._id,
      apiKey: newVps.apiKey, // Only shown once!
    });
  } catch (error) {
    next(error);
  }
};

export const listVps = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const list = await Vps.find({ ownerId }).sort({ createdAt: -1 });
    res.json(list);
  } catch (error) {
    next(error);
  }
};

export const deleteVps = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const result = await Vps.findOneAndDelete({ _id: id, ownerId });
    if (!result) return res.status(404).json({ error: 'VPS not found' });

    // Cascade delete runs (Optional, or let TTL handle it)
    await VpsRun.deleteMany({ vpsId: id });

    res.json({ message: 'VPS Deleted' });
  } catch (error) {
    next(error);
  }
};

export const updateVps = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const { name } = UpdateVpsSchema.parse(req.body);

    const updated = await Vps.findOneAndUpdate(
      { _id: id, ownerId },
      { name },
      { new: true, runValidators: true }
    );
    if (!updated) return res.status(404).json({ error: 'VPS not found' });

    res.json({ message: 'VPS Updated', vps: updated });
  } catch (error) {
    next(error);
  }
};

// --- Ingest Controller (The Executioner's Target) ---

export const ingestMetrics = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const vps = (req as any).vps;

    // 1. Synchronous Validation
    // Fail fast if payload is malformed
    const metrics = TelemetrySchema.parse(req.body.metrics);

    // 2. Fire and Forget Response
    // Unblock the agent immediately
    res.status(200).json({ status: 'ok' });

    // 3. Background Processing (via Queue)
    await enqueue<VpsIngestPayload>(
      vpsIngestQueue,
      { vpsId: vps._id.toString(), metrics },
      () => { processVpsIngestion(vps._id.toString(), metrics).catch(err => logger.error(`[VPS Ingest] Background Error for ${vps._id}:`, err)); },
    );

  } catch (error) {
    // If Zod validation fails, this catches it and sends 400
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Background VPS Processor (called by queue worker or in-process fallback)
// ---------------------------------------------------------------------------
export const processVpsIngestion = async (vpsId: string, metrics: any): Promise<void> => {
  const vps = await Vps.findById(vpsId);
  if (!vps) return;

  vps.lastSeen = new Date();
  vps.status = 'online';

  if (metrics.os) {
    (vps as any).metadata = {
      os: `${metrics.os.distro} ${metrics.os.release}`,
      hostname: metrics.os.hostname,
      arch: metrics.os.arch,
    };
  }

  vps.activeIntegrations = {
    nginx: !!metrics.nginx,
    traefik: !!metrics.traefik,
    terminal: metrics.terminalEnabled || false,
  };

  // anchor: createdAt ≈ now at insert
  const retentionMs = await getRetentionMs(vps.ownerId);

  await Promise.all([
    vps.save(),
    VpsRun.create({ vpsId: vps._id, metrics, expiresAt: new Date(Date.now() + retentionMs) }),
  ]);
};

// --- Helper: Zero-Fill VPS Time Series (1-minute resolution with online/offline status) ---
// VPS telemetry is raw per-minute data, not aggregated — always uses 1-minute stepping
// regardless of span, since the agent heartbeat IS the online/offline signal.
const EMPTY_VPS_METRICS = {
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
  traefik: null
} as const;

const round2 = (n: number | null | undefined): number =>
  n == null ? 0 : Math.round(n * 100) / 100;

/**
 * Buckets a VPS's raw per-minute runs into the resolved granularity entirely
 * server-side — the same `$group` + `$dateToString(bucketFormat)` approach every
 * other dashboard uses. Numeric gauges are averaged across the bucket (smooth
 * trends); structural fields (disk/gpus/docker/nginx/traefik) come from the
 * bucket's last sample (shape preserved for the frontend). A bucket is online
 * if it had at least one real (non-heartbeat-miss) sample.
 */
async function aggregateVpsBuckets(vpsId: mongoose.Types.ObjectId, resolved: ResolvedTimeRange) {
  // Average only over real samples: synthetic heartbeat-miss records carry
  // zeroed metrics, so mapping them to null (which $avg ignores) keeps the
  // averages from being dragged down during partial-downtime buckets.
  const missCond = { $eq: ['$metrics._heartbeat', 'miss'] };
  const avgReal = (path: string) => ({ $avg: { $cond: [missCond, null, path] } });

  const rows = await VpsRun.aggregate([
    { $match: { vpsId, createdAt: { $gte: resolved.startDate, $lte: resolved.endDate } } },
    { $sort: { createdAt: 1 } },
    {
      $group: {
        _id: { $dateToString: { format: resolved.bucketFormat, date: '$createdAt' } },
        total: { $sum: 1 },
        realSamples: { $sum: { $cond: [missCond, 0, 1] } },
        cpuUsage: avgReal('$metrics.cpu.usagePercent'),
        memUsagePercent: avgReal('$metrics.memory.usagePercent'),
        memUsed: avgReal('$metrics.memory.used'),
        memActive: avgReal('$metrics.memory.active'),
        memFree: avgReal('$metrics.memory.free'),
        memTotal: avgReal('$metrics.memory.total'),
        netRecv: avgReal('$metrics.network.bytesRecvSec'),
        netSent: avgReal('$metrics.network.bytesSentSec'),
        latencyMs: avgReal('$metrics.network.latencyMs'),
        temperature: avgReal('$metrics.hardware.temperature'),
        powerDraw: avgReal('$metrics.hardware.powerDraw'),
        procRunning: avgReal('$metrics.processes.running'),
        procSleeping: avgReal('$metrics.processes.sleeping'),
        procBlocked: avgReal('$metrics.processes.blocked'),
        procTotal: avgReal('$metrics.processes.total'),
        last: { $last: '$$ROOT' },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  return rows.map((b: any) => {
    const lastMetrics = b.last?.metrics ?? {};
    return {
      _id: b.last?._id,
      // _id is the bucketFormat string (e.g. "2024-01-15" or full ISO); parse
      // back to the bucket-start Date. The 1d format yields UTC midnight.
      createdAt: new Date(b._id),
      isOnline: b.realSamples > 0,
      uptimeRatio: b.total > 0 ? b.realSamples / b.total : 0,
      // Merge averaged scalars over the last sample's full structure so the
      // response shape is identical to a raw run.
      metrics: {
        ...lastMetrics,
        cpu: { ...lastMetrics.cpu, usagePercent: round2(b.cpuUsage) },
        memory: {
          ...lastMetrics.memory,
          usagePercent: round2(b.memUsagePercent),
          used: round2(b.memUsed),
          active: round2(b.memActive),
          free: round2(b.memFree),
          total: round2(b.memTotal),
        },
        network: {
          ...lastMetrics.network,
          bytesRecvSec: round2(b.netRecv),
          bytesSentSec: round2(b.netSent),
          latencyMs: round2(b.latencyMs),
        },
        hardware: {
          ...lastMetrics.hardware,
          temperature: round2(b.temperature),
          powerDraw: round2(b.powerDraw),
        },
        processes: {
          ...lastMetrics.processes,
          running: round2(b.procRunning),
          sleeping: round2(b.procSleeping),
          blocked: round2(b.procBlocked),
          total: round2(b.procTotal),
        },
      },
    };
  });
}

// --- Dashboard Stats Controller ---
export const getVpsStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const ownerId = (req as any).ownerId;
    const { range, start, end } = req.query;

    const vps = await Vps.findOne({ _id: id, ownerId });
    if (!vps) return res.status(404).json({ error: "VPS not found" });

    // Resolve time range via the centralized utility — identical bucketing to
    // every other dashboard (1m / 1h / 1d by span). No VPS-specific profile.
    const maxRetention = await getEffectiveRetention('server', ownerId);
    const resolved = resolveTimeRange(
      { range: range as string | undefined, start: start as string | undefined, end: end as string | undefined },
      maxRetention
    );

    // Downsample server-side: one representative point per bucket (averaged
    // scalar gauges + the bucket's last structural sample), bounded regardless
    // of range. For minute granularity (short windows) each bucket holds a
    // single sample, so this is loss-free and matches the raw real-time view.
    const buckets = await aggregateVpsBuckets(vps._id, resolved);
    const history = fillTimeGapsWithStatus(buckets, resolved, EMPTY_VPS_METRICS as any);

    // Most recent ONLINE snapshot, for the "current" stat cards — independent of
    // the (possibly downsampled) series so the cards always show real values.
    const latest = await VpsRun.findOne({
      vpsId: vps._id,
      'metrics._heartbeat': { $ne: 'miss' },
    })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ vps, history, latest, granularity: resolved.granularityLabel });
  } catch (error) {
    if (error instanceof TimeRangeError) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
}