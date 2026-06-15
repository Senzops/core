// ============================================================================
// Plan-based TTL schema helper
// ----------------------------------------------------------------------------
// Applies Senzor's unified, plan-based retention indexing to a telemetry
// schema. Every plan-based collection gets the same two TTL indexes:
//
//   1. Primary  — `{ expiresAt: 1 }` with expireAfterSeconds: 0. Each document
//                 carries its own absolute expiry (anchor + plan retention),
//                 set at write time and recomputed on plan change. MongoDB
//                 deletes each document exactly at its `expiresAt`. Documents
//                 with no `expiresAt` date are ignored by this index.
//
//   2. Backstop — `{ <anchor>: 1 }` with expireAfterSeconds: HARD_CAP_SECONDS.
//                 Defense-in-depth: if a write path ever omits `expiresAt`, the
//                 hard cap still bounds the document's lifetime to the platform
//                 maximum plus grace, so storage can never leak unbounded.
//
// The `expiresAt` schema path is added here so models can't forget it. Declare
// `expiresAt?: Date` on the model's TypeScript interface for type-safety.
// ============================================================================

import { Schema } from 'mongoose';
import { HARD_CAP_SECONDS } from '../config/retention';

export function applyPlanBasedTtl(schema: Schema, anchorField: string): void {
  if (!schema.path('expiresAt')) {
    schema.add({ expiresAt: { type: Date } });
  }

  // Primary per-document plan-based expiry.
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  // Hard-cap backstop on the native time anchor.
  schema.index({ [anchorField]: 1 }, { expireAfterSeconds: HARD_CAP_SECONDS });
}
