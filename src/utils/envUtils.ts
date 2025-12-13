// src/utils/EnvUtils.ts

export const EnvUtils = {
  /**
     * Helper: Unwraps a single chunk from Coolify's stringification.
     * If Coolify stored the chunk "{\"a\":", this returns {"a":
     */
  unwrapChunk: (chunkValue: string): string => {
    try {
      // Try to parse the chunk to see if it un-escapes into a string fragment
      const parsed = JSON.parse(chunkValue);

      // If the result is a string, it means it was a stringified string.
      // We return this "clean" string fragment.
      if (typeof parsed === 'string') {
        return parsed;
      }

      // If it parsed into an object/number, or stayed as is, return original
      return chunkValue;
    } catch (e) {
      // If it fails to parse (e.g. it was just a raw string like "ABC"), 
      // return it as is.
      return chunkValue;
    }
  },

  /**
     * RE-CONSTRUCT FUNCTION
     */
  getEnvValue: (baseKey: string): string | null => {
    // 1. Local/Standard Check (Full Key)
    if (process.env[baseKey]) {
      // Local .env usually isn't double-stringified, but let's be safe
      return process.env[baseKey] || null;
    }

    // 2. Chunked Check
    let assembledValue = '';
    let index = 0;

    while (true) {
      const chunkKey = `${baseKey}_${index}`;
      const chunkRaw = process.env[chunkKey];

      if (!chunkRaw) {
        break; // No more chunks
      }

      // CRITICAL STEP: Unwrap the chunk before adding it
      const chunkClean = EnvUtils.unwrapChunk(chunkRaw);

      assembledValue += chunkClean;
      index++;
    }

    return assembledValue.length > 0 ? assembledValue : null;
  },

  /**
   * FINAL PARSER
   * Takes the fully assembled string and turns it into the Object
   */
  parseAsObject: (input: string): any => {
    try {
      // The input should now be a perfect JSON string like {"type":...}
      return JSON.parse(input);
    } catch (e) {
      // Fallback: Sometimes even the assembled string has one layer of quotes left
      // depending on exactly how it was pasted.
      try {
        if (typeof input === 'string') {
          const cleaned = input.replace(/\\"/g, '"').replace(/^"|"$/g, '');
          return JSON.parse(cleaned);
        }
      } catch (e2) {
        throw new Error(`Could not parse assembled JSON. Raw length: ${input.length}`);
      }
      throw e;
    }
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
  },
};