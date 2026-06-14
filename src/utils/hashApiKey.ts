import crypto from 'crypto';

// ============================================================================
// API Key Hashing
// ----------------------------------------------------------------------------
// Ingestion keys are high-entropy random tokens (192 bits), so a fast one-way
// hash (SHA-256) is the correct primitive — not a slow password KDF. We store
// only the hash; the plaintext key is shown to the user exactly once at creation
// and is never recoverable. This is the same model used by GitHub PATs / Stripe
// restricted keys. Lookups are by deterministic hash equality.
// ============================================================================

export const hashApiKey = (key: string): string =>
  crypto.createHash('sha256').update(key, 'utf8').digest('hex');
