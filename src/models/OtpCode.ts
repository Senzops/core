import mongoose, { Schema, Document } from 'mongoose';

// ============================================================================
// OtpCode — one issued login verification code.
// ----------------------------------------------------------------------------
// Rows are NOT deleted when a code is used or replaced; they are marked with a
// terminal `status` and kept for a couple of hours. That retention is what makes
// send-rate limiting actually work: the previous implementation counted rows in
// the window *after* deleting every prior row for the address, so the count was
// structurally incapable of exceeding 1 and the per-account cap never fired.
//
// Two distinct clocks, deliberately named apart:
//   codeExpiresAt — how long the CODE may be redeemed (minutes)
//   expiresAt     — how long the ROW survives (hours), TTL-indexed
// `expiresAt` keeps the meaning the pre-existing TTL index was built on, so no
// index migration is required on a live deployment.
// ============================================================================

export type OtpStatus =
  | 'active'      // redeemable
  | 'consumed'    // successfully verified
  | 'superseded'  // replaced, expired, or attempt-exhausted
  | 'failed';     // delivery failed — excluded from the send-rate cap

export interface IOtpCode extends Document {
  uid: string;
  email: string;
  /** HMAC-SHA256(pepper, `${uid}:${code}`) — peppered and account-bound. */
  codeHash: string;
  status: OtpStatus;
  attempts: number;
  /** Redemption deadline for the code itself. */
  codeExpiresAt: Date;
  /** Row-purge deadline (TTL). Outlives the rate-limit window by design. */
  expiresAt: Date;
  consumedAt?: Date;
  lastAttemptAt?: Date;
  /** Audit context captured at issue time. */
  ip?: string;
  uaHash?: string;
  createdAt: Date;
}

const OtpCodeSchema = new Schema<IOtpCode>({
  uid: { type: String, required: true, index: true },
  email: { type: String, required: true, index: true },
  codeHash: { type: String, required: true },
  status: {
    type: String,
    enum: ['active', 'consumed', 'superseded', 'failed'],
    default: 'active',
    required: true,
  },
  attempts: { type: Number, default: 0 },
  codeExpiresAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  consumedAt: { type: Date },
  lastAttemptAt: { type: Date },
  ip: { type: String },
  uaHash: { type: String },
}, { timestamps: { createdAt: true, updatedAt: false } });

// Row reaper. Pre-existing index — field meaning is unchanged (a purge clock),
// only the horizon moved out, so this needs no migration.
OtpCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Hot paths: "newest code for this account" and "sends in the last hour".
OtpCodeSchema.index({ uid: 1, createdAt: -1 });
OtpCodeSchema.index({ uid: 1, status: 1, createdAt: -1 });

// Retained from the previous schema: pre-migration rows are keyed on email only.
OtpCodeSchema.index({ email: 1, createdAt: -1 });

export const OtpCode = mongoose.model<IOtpCode>('OtpCode', OtpCodeSchema);
