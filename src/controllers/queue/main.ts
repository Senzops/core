import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import { QueueSource, QueueMetric, QueueRollup, QueueSnapshot } from '../../models/Queue';
import { DashboardShare } from '../../models/DashboardShare';
import { encrypt } from '../../utils/crypto';
import { RegisterQueueSchema, UpdateQueueSchema } from '../../utils/validation';
import { discoverQueues, DEFAULT_MAX_QUEUES } from '../../worker/queue/adapters/bullmq';

// Verifies a BullMQ/Redis source is reachable and reports basic facts. A fresh
// instance with no queues yet is valid — we only require connectivity.
const testRedisConnection = async (
  uri: string,
  prefix: string
): Promise<{ version?: string; discoveredQueues: number; truncated: boolean }> => {
  const client = new Redis(uri, {
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    commandTimeout: 5000,
    lazyConnect: true,
    retryStrategy: () => null
  });
  client.on('error', () => {}); // surfaced via the connect/command rejection below

  try {
    await client.connect();
    await client.ping();

    let version: string | undefined;
    try {
      const info = await client.info('server');
      version = info.split('\n').find(l => l.startsWith('redis_version:'))?.split(':')[1]?.trim();
    } catch { /* non-fatal */ }

    const { names, truncated } = await discoverQueues(client, prefix, DEFAULT_MAX_QUEUES);
    return { version, discoveredQueues: names.length, truncated };
  } finally {
    client.disconnect();
  }
};

export const registerQueueSource = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { name, system, uri, prefix, queueFilter, interval } = RegisterQueueSchema.parse(req.body);

    let probe: { version?: string; discoveredQueues: number };
    try {
      probe = await testRedisConnection(uri, prefix);
    } catch (err: any) {
      return res.status(400).json({ error: 'Queue Source Connection Failed', details: err.message });
    }

    const newSource = await QueueSource.create({
      ownerId,
      name,
      system,
      encryptedUri: encrypt(uri),
      prefix,
      queueFilter,
      interval,
      status: 'online',
      lastCheck: new Date(),
      version: probe.version,
      discoveredQueues: probe.discoveredQueues,
      nextPollAt: new Date() // immediately due for the first poll
    });

    res.status(201).json({
      message: 'Queue Source Connected & Registered',
      sourceId: newSource._id,
      name: newSource.name,
      system: newSource.system,
      discoveredQueues: probe.discoveredQueues
    });
  } catch (error) {
    next(error);
  }
};

export const listQueueSources = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const sources = await QueueSource.find({ ownerId })
      .select('-encryptedUri -leasedBy -leaseExpiresAt')
      .sort({ createdAt: -1 });
    res.json(sources);
  } catch (error) {
    next(error);
  }
};

export const updateQueueSource = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const updates = UpdateQueueSchema.parse(req.body);

    const existing = await QueueSource.findOne({ _id: id, ownerId });
    if (!existing) return res.status(404).json({ error: 'Queue source not found' });

    const updateFields: Record<string, any> = {};
    if (updates.name !== undefined) updateFields.name = updates.name;
    if (updates.interval !== undefined) updateFields.interval = updates.interval;
    if (updates.queueFilter !== undefined) updateFields.queueFilter = updates.queueFilter;

    const effectivePrefix = updates.prefix ?? existing.prefix;
    if (updates.prefix !== undefined) updateFields.prefix = updates.prefix;

    // Re-test connectivity whenever the endpoint or prefix changes.
    if (updates.uri !== undefined || updates.prefix !== undefined) {
      const effectiveUri = updates.uri ?? null;
      try {
        if (effectiveUri !== null) {
          const probe = await testRedisConnection(effectiveUri, effectivePrefix);
          updateFields.encryptedUri = encrypt(effectiveUri);
          updateFields.version = probe.version;
          updateFields.discoveredQueues = probe.discoveredQueues;
        }
      } catch (err: any) {
        return res.status(400).json({ error: 'Queue Source Connection Failed', details: err.message });
      }
      // Reset health and re-poll promptly after a config change.
      updateFields.status = 'online';
      updateFields.lastCheck = new Date();
      updateFields.errorMessage = undefined;
      updateFields.consecutiveFailures = 0;
      updateFields.backoffUntil = undefined;
      updateFields.nextPollAt = new Date();
    }

    const updated = await QueueSource.findOneAndUpdate(
      { _id: id, ownerId },
      updateFields,
      { new: true, runValidators: true }
    ).select('-encryptedUri -leasedBy -leaseExpiresAt');

    res.json({ message: 'Queue Source Updated', source: updated });
  } catch (error) {
    next(error);
  }
};

export const deleteQueueSource = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const result = await QueueSource.findOneAndDelete({ _id: id, ownerId });
    if (!result) return res.status(404).json({ error: 'Queue source not found' });

    await Promise.all([
      QueueMetric.deleteMany({ sourceId: id }),
      QueueRollup.deleteMany({ sourceId: id }),
      QueueSnapshot.deleteOne({ sourceId: id }),
      DashboardShare.deleteMany({ scopeType: 'queue', scopeId: id, ownerId })
    ]);

    res.json({ message: 'Queue source and all metric history deleted' });
  } catch (error) {
    next(error);
  }
};
