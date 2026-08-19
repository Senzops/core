import { Request, Response, NextFunction } from 'express';
import { DatabaseService, DbMetric, DbCollectionStat } from '../../models/Database';
import { DbQueryStat, DbSlowOp } from '../../models/DbQueryInsight';
import { DbIndexStat } from '../../models/DbIndexStat';
import { DashboardShare } from '../../models/DashboardShare';
import { encrypt } from '../../utils/crypto';
import { UpdateDbSchema } from '../../utils/validation';
import { getAdapter, isSupportedDbType, type Capabilities, type DbType } from '../../worker/database/adapters';
import { logger } from '../../utils/logger';
import { z } from 'zod';

const RegisterDbSchema = z.object({
  name: z.string().min(1).max(50),
  type: z.enum(['mongodb', 'postgresql', 'mysql', 'redis']),
  uri: z.string(), // Removed strict .url() validation because redis strings can lack standard URL formatting
  interval: z.number().min(1).max(60).default(5)
});

const ENGINE_LABEL: Record<DbType, string> = {
  mongodb: 'MongoDB',
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  redis: 'Redis',
};

/**
 * Validates connectivity and discovers what the supplied credentials may read.
 *
 * Registration is the natural place to probe: the operator is present, so a
 * least-privilege monitoring user that cannot see query statistics can be
 * reported immediately rather than surfacing later as an inexplicably empty
 * dashboard. Connectivity failures are returned to the caller; a reachable
 * instance with restricted privileges is accepted, with the restrictions
 * recorded for the UI to explain.
 */
const probeConnection = async (
  type: DbType,
  uri: string
): Promise<{ ok: true; capabilities: Capabilities } | { ok: false; details: string }> => {
  try {
    const capabilities = await getAdapter(type).probe(uri);
    return { ok: true, capabilities };
  } catch (err: any) {
    return { ok: false, details: err?.message || 'Connection failed.' };
  }
};

export const registerDatabase = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { name, type, uri, interval } = RegisterDbSchema.parse(req.body);

    if (!isSupportedDbType(type)) {
      return res.status(400).json({ error: `Adapter for ${type} is not yet implemented.` });
    }

    const probe = await probeConnection(type, uri);
    if (!probe.ok) {
      return res.status(400).json({
        error: `${ENGINE_LABEL[type]} Connection Failed`,
        details: probe.details,
      });
    }

    const newDb = await DatabaseService.create({
      ownerId,
      name,
      type,
      encryptedUri: encrypt(uri),
      interval,
      status: 'online',
      lastCheck: new Date(),
      capabilities: probe.capabilities,
      capabilitiesCheckedAt: new Date(),
    });

    res.status(201).json({
      message: 'Database Connected & Registered',
      dbId: newDb._id,
      name: newDb.name,
      type: newDb.type,
      capabilities: probe.capabilities,
    });
  } catch (error) {
    next(error);
  }
};

export const listDatabases = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const dbs = await DatabaseService.find({ ownerId }).select('-encryptedUri').sort({ createdAt: -1 });
    res.json(dbs);
  } catch (error) {
    next(error);
  }
};

export const updateDatabase = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const updates = UpdateDbSchema.parse(req.body);

    const existing = await DatabaseService.findOne({ _id: id, ownerId });
    if (!existing) return res.status(404).json({ error: 'Database not found' });

    const updateFields: Record<string, any> = {};
    if (updates.name !== undefined) updateFields.name = updates.name;
    if (updates.interval !== undefined) updateFields.interval = updates.interval;

    const effectiveType = (updates.type || existing.type) as DbType;
    if (updates.type !== undefined) updateFields.type = updates.type;

    if (!isSupportedDbType(effectiveType)) {
      return res.status(400).json({ error: `Adapter for ${effectiveType} is not yet implemented.` });
    }

    // Re-probe whenever the connection target changes: new credentials can
    // carry different privileges, and stale capabilities would misreport what
    // the dashboard can show.
    if (updates.uri !== undefined) {
      const probe = await probeConnection(effectiveType, updates.uri);
      if (!probe.ok) {
        return res.status(400).json({
          error: `${ENGINE_LABEL[effectiveType]} Connection Failed`,
          details: probe.details,
        });
      }

      updateFields.encryptedUri = encrypt(updates.uri);
      updateFields.status = 'online';
      updateFields.lastCheck = new Date();
      updateFields.errorMessage = undefined;
      updateFields.capabilities = probe.capabilities;
      updateFields.capabilitiesCheckedAt = new Date();
    }

    const updated = await DatabaseService.findOneAndUpdate(
      { _id: id, ownerId },
      updateFields,
      { new: true, runValidators: true }
    ).select('-encryptedUri');

    res.json({ message: 'Database Updated', database: updated });
  } catch (error) {
    next(error);
  }
};

export const deleteDatabase = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const result = await DatabaseService.findOneAndDelete({ _id: id, ownerId });
    if (!result) return res.status(404).json({ error: 'Database not found' });

    await DbMetric.deleteMany({ dbId: id });
    await DbCollectionStat.deleteOne({ dbId: id });
    await DbQueryStat.deleteMany({ dbId: id });
    await DbSlowOp.deleteMany({ dbId: id });
    await DbIndexStat.deleteOne({ dbId: id });
    await DashboardShare.deleteMany({ scopeType: 'database', scopeId: id, ownerId });

    // Pooled clients live in the worker process, which reclaims them on its
    // hourly sweep once the registry row is gone.
    logger.info(`[Database] Removed ${id} and all metric history`);

    res.json({ message: 'Database and all metric history deleted' });
  } catch (error) {
    next(error);
  }
};
