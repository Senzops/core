import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { QueueSource, QueueMetric, QueueRollup, QueueSnapshot, QueueSystem } from '../../models/Queue';
import { DashboardShare } from '../../models/DashboardShare';
import { encrypt, decrypt } from '../../utils/crypto';
import { RegisterQueueSchema, UpdateQueueSchema, queueConnectionSchema } from '../../utils/validation';
import { getAdapter, disposeAllAdapters } from '../../worker/queue/adapters';

const SELECT_PUBLIC = '-encryptedConfig -leasedBy -leaseExpiresAt';

// Non-secret connection fields surfaced to the UI for display/edit prefill.
// Anything that grants access (URIs with creds, passwords, secret keys) is
// deliberately omitted and only ever lives encrypted in `encryptedConfig`.
const stripSecrets = (system: QueueSystem, conn: any): Record<string, any> => {
  switch (system) {
    case 'bullmq': return { prefix: conn.prefix };
    case 'rabbitmq': return { apiUrl: conn.apiUrl, username: conn.username, vhost: conn.vhost };
    case 'kafka': return { brokers: conn.brokers, ssl: conn.ssl, saslMechanism: conn.saslMechanism, username: conn.username };
    case 'sqs': return { region: conn.region, accessKeyId: conn.accessKeyId };
    default: return {};
  }
};

const validateConnection = (system: QueueSystem, raw: any) => {
  const schema = queueConnectionSchema(system);
  if (!schema) throw Object.assign(new Error(`Unsupported queue system: ${system}`), { statusCode: 400 });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw Object.assign(new Error('Invalid connection config'), { statusCode: 400, details: parsed.error });
  }
  return parsed.data as any;
};

export const registerQueueSource = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { name, system, mode, connection, queueFilter, interval } = RegisterQueueSchema.parse(req.body);

    // --- Collector (push) mode: issue an ingest key, no server-side connection ---
    if (mode === 'collector') {
      const apiKey = `sqk_${crypto.randomBytes(24).toString('hex')}`;
      const newSource = await QueueSource.create({
        ownerId,
        name,
        system,
        mode: 'collector',
        apiKey,
        connectionMeta: {},
        queueFilter,
        interval,
        status: 'offline', // becomes online on first push
        discoveredQueues: 0,
        // Never claimed by the poller (collector sources are excluded), but keep
        // it far in the future as defence-in-depth.
        nextPollAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000)
      });

      return res.status(201).json({
        message: 'Queue Collector Registered',
        sourceId: newSource._id,
        name: newSource.name,
        system: newSource.system,
        mode: 'collector',
        apiKey
      });
    }

    // --- Agentless (pull) mode: validate + test the connection we'll poll ---
    if (!connection) {
      return res.status(400).json({ error: 'A connection is required for agentless mode.' });
    }
    const conn = validateConnection(system, connection);

    let probe: { version?: string; discoveredQueues: number };
    try {
      probe = await getAdapter(system).testConnection(conn);
    } catch (err: any) {
      return res.status(400).json({ error: 'Queue Source Connection Failed', details: err.message });
    }

    const newSource = await QueueSource.create({
      ownerId,
      name,
      system,
      mode: 'agentless',
      encryptedConfig: encrypt(JSON.stringify(conn)),
      connectionMeta: stripSecrets(system, conn),
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
      mode: 'agentless',
      discoveredQueues: probe.discoveredQueues
    });
  } catch (error: any) {
    if (error?.statusCode === 400) {
      return res.status(400).json({ error: error.message, details: error.details });
    }
    next(error);
  }
};

export const listQueueSources = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const sources = await QueueSource.find({ ownerId }).select(SELECT_PUBLIC).sort({ createdAt: -1 });
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

    // Collector-mode sources hold no server-side connection — ignore any
    // connection payload for them (only name/interval/queueFilter apply).
    if (updates.connection !== undefined && existing.mode === 'agentless') {
      // The connection may arrive partial (e.g. secrets unchanged). Merge over
      // the decrypted existing config, then re-validate and re-test as a whole.
      let current: any = {};
      try {
        if (existing.encryptedConfig) current = JSON.parse(decrypt(existing.encryptedConfig));
      } catch { /* fall back to provided values only */ }

      const merged = { ...current, ...updates.connection };
      const conn = validateConnection(existing.system, merged);

      try {
        const probe = await getAdapter(existing.system).testConnection(conn);
        updateFields.version = probe.version;
        updateFields.discoveredQueues = probe.discoveredQueues;
      } catch (err: any) {
        return res.status(400).json({ error: 'Queue Source Connection Failed', details: err.message });
      }

      updateFields.encryptedConfig = encrypt(JSON.stringify(conn));
      updateFields.connectionMeta = stripSecrets(existing.system, conn);
      updateFields.status = 'online';
      updateFields.lastCheck = new Date();
      updateFields.errorMessage = undefined;
      updateFields.consecutiveFailures = 0;
      updateFields.backoffUntil = undefined;
      updateFields.nextPollAt = new Date();

      // Drop any pooled client bound to the previous config.
      await disposeAllAdapters(id as string);
    }

    const updated = await QueueSource.findOneAndUpdate(
      { _id: id, ownerId },
      updateFields,
      { new: true, runValidators: true }
    ).select(SELECT_PUBLIC);

    res.json({ message: 'Queue Source Updated', source: updated });
  } catch (error: any) {
    if (error?.statusCode === 400) {
      return res.status(400).json({ error: error.message, details: error.details });
    }
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
      DashboardShare.deleteMany({ scopeType: 'queue', scopeId: id, ownerId }),
      disposeAllAdapters(id as string)
    ]);

    res.json({ message: 'Queue source and all metric history deleted' });
  } catch (error) {
    next(error);
  }
};
