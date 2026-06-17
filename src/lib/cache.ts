import Redis from 'ioredis';
import { logger } from '../utils/logger';

/**
 * Lightweight, fail-open cache built on a dedicated ioredis connection.
 *
 * Used to shield the database from refresh storms / scraping on the public,
 * unauthenticated dashboard-share endpoints. Every operation degrades silently
 * to a cache miss if Redis is unavailable, so a Redis outage never takes the
 * public read path down — it just removes the optimization.
 */

let client: Redis | null = null;
let disabled = false;

function getClient(): Redis | null {
  if (disabled) return null;
  if (client) return client;

  try {
    client = new Redis(process.env.REDIS_QUEUE_URL || 'redis://localhost:6379', {
      // Keep failures cheap and non-blocking: don't queue commands while offline,
      // give up after a couple of retries, and never let a missing Redis stall a request.
      lazyConnect: false,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1500,
      retryStrategy: (times) => (times > 5 ? null : Math.min(times * 200, 1000)),
    });

    client.on('error', (err) => {
      // Log once-ish; ioredis emits frequently while down. Keep it at warn.
      logger.warn(`[Cache] Redis error: ${err.message}`);
    });
  } catch (err: any) {
    logger.warn(`[Cache] Failed to initialize Redis client, caching disabled: ${err.message}`);
    disabled = true;
    return null;
  }

  return client;
}

export async function cacheGet(key: string): Promise<string | null> {
  const c = getClient();
  if (!c || c.status !== 'ready') return null;
  try {
    return await c.get(key);
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  const c = getClient();
  if (!c || c.status !== 'ready') return;
  try {
    await c.set(key, value, 'EX', ttlSeconds);
  } catch {
    /* fail open */
  }
}

export async function shutdownCache(): Promise<void> {
  if (client) {
    try {
      await client.quit();
    } catch {
      /* ignore */
    }
    client = null;
  }
}
