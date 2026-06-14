import { LogIngestStat } from '../models/Log';
import { logger } from '../utils/logger';

// ============================================================================
// Log Ingestion Observability
// ----------------------------------------------------------------------------
// Records accepted/dropped counters per tenant in hourly buckets so the
// dashboard can answer "are my logs landing, or being dropped?". Fire-and-forget
// and non-fatal — observability must never affect the ingestion path itself.
// ============================================================================

const hourBucket = (d = new Date()): Date => {
  const b = new Date(d);
  b.setMinutes(0, 0, 0);
  return b;
};

/**
 * Atomically increments the accepted/dropped counters for the current hour.
 * Safe to await-and-ignore; failures are logged but never thrown.
 */
export const recordIngestStat = async (ownerId: string, accepted: number, dropped: number): Promise<void> => {
  if (!ownerId || (accepted <= 0 && dropped <= 0)) return;
  try {
    await LogIngestStat.updateOne(
      { ownerId, bucket: hourBucket() },
      { $inc: { accepted: Math.max(0, accepted), dropped: Math.max(0, dropped) } },
      { upsert: true },
    );
  } catch (err: any) {
    logger.warn(`[LOGS] Ingest stat record failed: ${err.message}`);
  }
};
