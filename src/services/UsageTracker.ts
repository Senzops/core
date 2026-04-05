import { Subscription } from '../models/Subscription';
import { logger } from '../utils/logger';

class UsageTrackerService {
  // ownerId (string) -> bytes added since last flush
  private buffer: Map<string, number> = new Map();
  private flushIntervalMs = 10000; // Flush every 10 seconds
  private isFlushing = false;

  constructor() {
    // Start the background flush cycle
    setInterval(() => this.flush(), this.flushIntervalMs);
  }

  /**
   * Tracks incoming bytes in high-speed RAM.
   */
  public addUsage(ownerId: string, bytes: number) {
    if (bytes <= 0) return;
    const current = this.buffer.get(ownerId) || 0;
    this.buffer.set(ownerId, current + bytes);
  }

  /**
   * Reads current un-flushed bytes in RAM to accurately check limits.
   */
  public getPendingUsage(ownerId: string): number {
    return this.buffer.get(ownerId) || 0;
  }

  /**
   * Safely commits RAM data to MongoDB in a single bulk operation.
   */
  private async flush() {
    if (this.isFlushing || this.buffer.size === 0) return;

    this.isFlushing = true;

    // Clone and clear buffer so we don't drop traffic while querying DB
    const snapshot = new Map(this.buffer);
    this.buffer.clear();

    try {
      const bulkOps = [];
      for (const [ownerId, bytes] of snapshot.entries()) {
        bulkOps.push({
          updateOne: {
            filter: { ownerId },
            update: { $inc: { currentMonthBytes: bytes } }
          }
        });
      }

      if (bulkOps.length > 0) {
        await Subscription.bulkWrite(bulkOps, { ordered: false });
        logger.debug(`[UsageTracker] Flushed ingestion usage for ${bulkOps.length} tenants.`);
      }
    } catch (error: any) {
      logger.error(`[UsageTracker] Flush failed. Recovering bytes to buffer. Error: ${error.message}`);
      // Safety net: If DB goes down, put the bytes back so they aren't lost
      for (const [ownerId, bytes] of snapshot.entries()) {
        this.addUsage(ownerId, bytes);
      }
    } finally {
      this.isFlushing = false;
    }
  }
}

export const UsageTracker = new UsageTrackerService();