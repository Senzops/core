import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { Vps, VpsRun } from '../models/Vps';
import { User } from '../models/User';
import { RegisterVpsSchema, UpdateVpsSchema, TelemetrySchema } from '../utils/validation';
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

// --- Helper: Zero-Fill Time Series (Returns 0 for missing data) ---
const fillTimeGaps = (data: any[], range: string, startDate: Date) => {
  const filled = [];
  const now = new Date();

  let current = new Date(startDate);
  current.setSeconds(0, 0);
  current.setMinutes(current.getMinutes() + 1);

  const end = new Date(now);
  end.setSeconds(0, 0);

  const dataMap = new Map();
  for (const item of data) {
    const d = new Date(item.createdAt);
    d.setSeconds(0, 0);
    dataMap.set(d.getTime(), item);
  }

  while (current < end) {
    const key = current.getTime();
    const item = dataMap.get(key);

    if (item) {
      filled.push({ ...item, isOnline: true });
    } else {
      // Safe, compliant empty structure
      filled.push({
        _id: 'gap-' + key,
        createdAt: current.toISOString(),
        isOnline: false,
        metrics: {
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
        }
      });
    }

    current.setMinutes(current.getMinutes() + 1);
  }

  return filled;
};

// --- Dashboard Stats Controller ---
export const getVpsStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { uid } = (req as any).user;
    const { range = '1h' } = req.query;

    const vps = await Vps.findOne({ _id: id, ownerId: uid });
    if (!vps) return res.status(404).json({ error: "VPS not found" });

    const now = new Date();
    const startDate = new Date();

    switch (range) {
      case '1h': startDate.setHours(now.getHours() - 1); break;
      case '3h': startDate.setHours(now.getHours() - 3); break;
      case '6h': startDate.setHours(now.getHours() - 6); break;
      case '12h': startDate.setHours(now.getHours() - 12); break;
      case '24h':
      default: startDate.setHours(now.getHours() - 24); break;
    }

    const runs = await VpsRun.find({
      vpsId: id,
      createdAt: { $gte: startDate }
    })
      .sort({ createdAt: 1 })
      .lean();

    const history = fillTimeGaps(runs, range as string, startDate);

    res.json({ vps, history });
  } catch (error) {
    next(error);
  }
}