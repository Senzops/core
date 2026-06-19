import { Request, Response } from 'express';
import { QueueSource } from '../../models/Queue';
import { QueueIngestSchema } from '../../utils/validation';
import { persistQueueSamples } from '../../worker/queue/persist';
import { logger } from '../../utils/logger';

// ============================================================================
// Collector push ingest — POST /api/ingest/queue
// ----------------------------------------------------------------------------
// A customer-run collector samples its broker locally (reusing the same adapter
// code) and pushes the resulting QueueSamples here, authenticated by the
// source's apiKey. The payload flows through the exact same persistence layer
// the agentless poller uses, so push and pull produce identical data.
//
// Responds 202 immediately, then persists in the background — ingestion must
// never block the collector's loop.
// ============================================================================

export const ingestQueueBatch = async (req: Request, res: Response) => {
  try {
    const apiKey = req.headers['x-service-api-key'] as string;
    if (!apiKey) return res.status(401).json({ error: 'Missing API Key' });

    const source = await QueueSource.findOne({ apiKey, mode: 'collector' });
    if (!source) return res.status(403).json({ error: 'Invalid API Key' });

    const parsed = QueueIngestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload format', details: parsed.error });
    }

    res.status(202).json({ status: 'accepted', queued: parsed.data.samples.length });

    // Background persistence — never block the collector.
    persistAndUpdate(source, parsed.data).catch(err =>
      logger.error(`[Queue Ingest] Background persist failed for ${source._id}: ${err.message}`)
    );
  } catch (error: any) {
    logger.error('[Queue Ingest] Error', error);
    if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error' });
  }
};

const persistAndUpdate = async (
  source: any,
  data: { samples: any[]; version?: string; discovered?: number; truncated?: boolean }
) => {
  await persistQueueSamples(source, data.samples as any[]);

  const discovered = data.discovered ?? data.samples.length;
  await QueueSource.updateOne(
    { _id: source._id },
    {
      $set: {
        status: 'online',
        lastCheck: new Date(),
        discoveredQueues: discovered,
        version: data.version,
        errorMessage: data.truncated
          ? `Collector reported truncation: monitoring ${data.samples.length} of ${discovered}+ queues.`
          : undefined,
        consecutiveFailures: 0,
        backoffUntil: undefined
      }
    }
  );
};
