import { logger } from './logger';

interface DodoClientConfig {
  maxRetries?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
}

const DEFAULT_CONFIG: Required<DodoClientConfig> = {
  maxRetries: 2,
  timeoutMs: 15000,
  baseDelayMs: 500,
};

function getDodoBaseUrl(): string {
  const isLive = process.env.DODO_ENV === 'live';
  return isLive ? 'https://live.dodopayments.com' : 'https://test.dodopayments.com';
}

function getDodoApiKey(): string {
  const key = process.env.DODO_API_KEY;
  if (!key) {
    throw new Error('DODO_API_KEY environment variable is not configured');
  }
  return key;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function dodoRequest<T = any>(
  path: string,
  options: RequestInit & DodoClientConfig = {},
): Promise<T> {
  const { maxRetries, timeoutMs, baseDelayMs, ...fetchOptions } = {
    ...DEFAULT_CONFIG,
    ...options,
  };

  const baseUrl = getDodoBaseUrl();
  const apiKey = getDodoApiKey();
  const url = `${baseUrl}${path}`;

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...(fetchOptions.headers as Record<string, string> || {}),
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...fetchOptions,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        const error = new DodoApiError(
          `Dodo API ${fetchOptions.method || 'GET'} ${path} failed: ${response.status}`,
          response.status,
          errorBody,
        );

        // Don't retry client errors (4xx) except 429 (rate limit)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          throw error;
        }

        lastError = error;
      } else {
        const data = await response.json().catch(() => ({}));
        return data as T;
      }
    } catch (err: any) {
      clearTimeout(timer);

      if (err instanceof DodoApiError && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 429) {
        throw err;
      }

      lastError = err;

      if (err.name === 'AbortError') {
        lastError = new Error(`Dodo API request to ${path} timed out after ${timeoutMs}ms`);
      }
    }

    if (attempt < maxRetries) {
      const delay = baseDelayMs * Math.pow(2, attempt);
      logger.warn(`[DodoClient] Retry ${attempt + 1}/${maxRetries} for ${path} in ${delay}ms`);
      await sleep(delay);
    }
  }

  logger.error(`[DodoClient] All ${maxRetries + 1} attempts failed for ${path}`);
  throw lastError || new Error(`Dodo API request to ${path} failed`);
}

export class DodoApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body: any,
  ) {
    super(message);
    this.name = 'DodoApiError';
  }
}
