import mongoose, { Schema, Document } from 'mongoose';

// ============================================================================
// AuthSession — server-side proof that a sign-in cleared the email OTP step.
// ----------------------------------------------------------------------------
// Firebase proves *who* the caller is; it does not prove they cleared Senzor's
// second factor. This collection is that proof, and it is the only thing the
// API trusts — the browser's localStorage flag is a UX cache, nothing more.
//
// A session is keyed on (uid, authTime) where `authTime` is the Firebase token's
// `auth_time` claim: the moment the user actually signed in. Token refreshes
// preserve auth_time, so a verified session survives them; a *new* sign-in
// produces a new auth_time and therefore requires a fresh OTP. That single
// binding is what makes "verify once per sign-in" enforceable server-side.
//
// Sessions are revocable (see revokeSessions) and expire absolutely, so a
// long-lived Firebase refresh token can never grant unlimited unverified reach.
// ============================================================================

export interface IAuthSession extends Document {
  uid: string;
  email: string;
  /** Firebase `auth_time` claim (epoch SECONDS) — pins this to one sign-in. */
  authTime: number;
  verifiedAt: Date;
  /** Absolute expiry. TTL-indexed: Mongo reaps the row, no cron needed. */
  expiresAt: Date;
  /** Audit context captured at verification time. */
  ip?: string;
  uaHash?: string;
  createdAt: Date;
}

const AuthSessionSchema = new Schema<IAuthSession>({
  uid: { type: String, required: true, index: true },
  email: { type: String, required: true },
  authTime: { type: Number, required: true },
  verifiedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  ip: { type: String },
  uaHash: { type: String },
}, { timestamps: { createdAt: true, updatedAt: false } });

// One session per (uid, sign-in). Re-verifying the same sign-in refreshes the
// existing row rather than accumulating duplicates.
AuthSessionSchema.index({ uid: 1, authTime: 1 }, { unique: true });

// Absolute-expiry reaper.
AuthSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AuthSession = mongoose.model<IAuthSession>('AuthSession', AuthSessionSchema);
