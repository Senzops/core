import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { Vps, VpsRun } from '../models/Vps';
import { RegisterVpsSchema, UpdateVpsSchema, TelemetrySchema } from '../utils/validation';
import { resolveTimeRange, getEffectiveRetention, TimeRangeError, type ResolvedTimeRange } from '../utils/timeRange';
import { logger } from '../utils/logger';

// --- VPS Controller ---

export const registerVps = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid, email } = (req as any).user;
    const { name } = RegisterVpsSchema.parse(req.body);

    // Generate a secure API Key
    const apiKey = crypto.randomBytes(24).toString('hex');

    const newVps = await Vps.create({
      ownerId: uid,
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
    const { uid } = (req as any).user;
    const list = await Vps.find({ ownerId: uid }).sort({ createdAt: -1 });
    res.json(list);
  } catch (error) {
    next(error);
  }
};

export const deleteVps = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;

    const result = await Vps.findOneAndDelete({ _id: id, ownerId: uid });
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
    const { uid } = (req as any).user;
    const { id } = req.params;
    const { name } = UpdateVpsSchema.parse(req.body);

    const updated = await Vps.findOneAndUpdate(
      { _id: id, ownerId: uid },
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

    // 3. Background Processing
    setImmediate(async () => {
      try {
        // Update Heartbeat & Status
        vps.lastSeen = new Date();
        vps.status = 'online';

        // Update metadata
        if (metrics.os) {
          vps.metadata = {
            os: `${metrics.os.distro} ${metrics.os.release}`,
            hostname: metrics.os.hostname,
            arch: metrics.os.arch
          };
        }

        // Update Active Integrations Status
        vps.activeIntegrations = {
          nginx: !!metrics.nginx,
          traefik: !!metrics.traefik,
          terminal: metrics.terminalEnabled || false,
        };

        // Parallel Writes
        await Promise.all([
          vps.save(), // Update Registry
          VpsRun.create({ // Insert Telemetry
            vpsId: vps._id,
            metrics: metrics,
          })
        ]);

      } catch (bgError) {
        // Log background failures since we can't respond to client anymore
        logger.error(`[VPS Ingest] Background Error for ${vps._id}:`, bgError);
      }
    });

  } catch (error) {
    // If Zod validation fails, this catches it and sends 400
    next(error);
  }
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

function fillVpsTimeGaps(data: any[], resolved: ResolvedTimeRange) {
  const filled: any[] = [];

  const current = new Date(resolved.startDate);
  current.setSeconds(0, 0);
  current.setMinutes(current.getMinutes() + 1);

  const end = new Date(resolved.endDate);
  end.setSeconds(0, 0);

  // Index existing runs by minute-aligned timestamp
  const dataMap = new Map<number, any>();
  for (const item of data) {
    const d = new Date(item.createdAt);
    d.setSeconds(0, 0);
    dataMap.set(d.getTime(), item);
  }

  while (current <= end) {
    const key = current.getTime();
    const item = dataMap.get(key);

    if (item) {
      filled.push({ ...item, isOnline: true });
    } else {
      filled.push({
        _id: 'gap-' + key,
        createdAt: current.toISOString(),
        isOnline: false,
        metrics: { ...EMPTY_VPS_METRICS },
      });
    }

    current.setMinutes(current.getMinutes() + 1);
  }

  return filled;
}

// --- Dashboard Stats Controller ---
export const getVpsStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { uid } = (req as any).user;
    const { range, start, end } = req.query;

    const vps = await Vps.findOne({ _id: id, ownerId: uid });
    if (!vps) return res.status(404).json({ error: "VPS not found" });

    // Resolve time range via centralized utility
    const maxRetention = await getEffectiveRetention('server', uid);
    const resolved = resolveTimeRange(
      { range: range as string | undefined, start: start as string | undefined, end: end as string | undefined },
      maxRetention
    );

    const runs = await VpsRun.find({
      vpsId: id,
      createdAt: { $gte: resolved.startDate, $lte: resolved.endDate },
    })
      .sort({ createdAt: 1 })
      .lean();

    const history = fillVpsTimeGaps(runs, resolved);

    res.json({ vps, history });
  } catch (error) {
    if (error instanceof TimeRangeError) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
}