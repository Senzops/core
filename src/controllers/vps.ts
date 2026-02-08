import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { Vps, VpsRun } from '../models/Vps';
import { User } from '../models/User';
import { RegisterVpsSchema, TelemetrySchema } from '../utils/validation';

// --- VPS Controller ---

export const registerVps = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid, email } = (req as any).user;
    const { name } = RegisterVpsSchema.parse(req.body);

    // Ensure user exists in our DB (Syncing with Firebase)
    await User.findOneAndUpdate(
      { firebaseUid: uid },
      { firebaseUid: uid, email },
      { upsert: true, new: true }
    );

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

// --- Ingest Controller (The Executioner's Target) ---

export const ingestMetrics = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const vps = (req as any).vps;

    // 1. Validate Payload
    const metrics = TelemetrySchema.parse(req.body.metrics);

    // 2. Fire and Forget Storage (Optimistic response)
    // We update the "Heartbeat" (Last Seen) immediately
    vps.lastSeen = new Date();
    vps.status = 'online';

    // Update metadata if it changed (OS info)
    if (metrics.os) {
      vps.metadata = {
        os: `${metrics.os.distro} ${metrics.os.release}`,
        hostname: metrics.os.hostname,
        arch: metrics.os.arch,
      };
    }

    // If data is present (not null), mark as active
    vps.activeIntegrations = {
      nginx: !!metrics.nginx,
      traefik: !!metrics.traefik,
      terminal: metrics.terminalEnabled || false,
    };

    await vps.save();

    // 3. Store the Run
    await VpsRun.create({
      vpsId: vps._id,
      metrics: metrics,
    });

    res.status(200).json({ status: 'ok' });
  } catch (error) {
    next(error);
  }
};

// --- Dashboard Stats Controller ---
export const getVpsStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { uid } = (req as any).user;

    // Parse optional limit, fallback to 60, enforce min/max bounds
    const limit = Math.min(
      Math.max(parseInt(req.query.limit as string) || 60, 1),
      1500
    );

    // Verify ownership
    const vps = await Vps.findOne({ _id: id, ownerId: uid });
    if (!vps) return res.status(404).json({ error: "VPS not found" });

    // Get last 60 runs (approx last hour of data)
    const runs = await VpsRun.find({ vpsId: id })
      .sort({ createdAt: -1 }).limit(limit);

    res.json({ vps, history: runs.reverse() });
  } catch (error) {
    next(error);
  }
}