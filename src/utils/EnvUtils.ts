// src/utils/EnvUtils.ts

export const EnvUtils = {
  /**
   * RE-CONSTRUCT FUNCTION
   * Checks for the base key first (Local). 
   * If missing, looks for numbered chunks (Prod/Coolify).
   */
  getEnvValue: (baseKey: string): string | null => {
    // 1. Local/Standard Check: If the full key exists, use it.
    if (process.env[baseKey]) {
      return process.env[baseKey] || null;
    }

    // 2. Chunked Check: Look for baseKey_0, baseKey_1, etc.
    let assembledValue = '';
    let index = 0;

    while (true) {
      // We assume the naming convention is KEY_0, KEY_1, etc.
      const chunkKey = `${baseKey}_${index}`;
      const chunkValue = process.env[chunkKey];

      if (!chunkValue) {
        break; // Stop when we run out of sequential chunks
      }

      assembledValue += chunkValue;
      index++;
    }

    return assembledValue.length > 0 ? assembledValue : null;
  },

  /**
   * SPLIT FUNCTION
   * Takes a long string and returns an object of chunks 
   * with max length of 250.
   */
  splitEnvValue: (baseKey: string, value: string) => {
    const CHUNK_SIZE = 250;
    const chunks: Record<string, string> = {};

    // Calculate how many chunks we need
    const totalChunks = Math.ceil(value.length / CHUNK_SIZE);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = start + CHUNK_SIZE;
      // Slice is safe; it won't remove data, just extract it
      const chunkVal = value.slice(start, end);

      // key format: FIREBASE_SERVICE_ACCOUNT_0
      chunks[`${baseKey}_${i}`] = chunkVal;
    }

    return chunks;
  }
};