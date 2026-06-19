import mongoose, { Schema, Document } from 'mongoose';

/**
 * DashboardShare — a public, view-only, time-bounded link to a single dashboard.
 *
 * One dashboard (any telemetry service or a Saved View) can have many shares,
 * each with its own label, expiry and revocation state.
 *
 * The link is a CAPABILITY URL, not a secret credential: it grants read-only
 * access to data the owner explicitly chose to publish, and is instantly
 * revocable. Like Grafana/Datadog/Metabase public dashboards, the token is stored
 * so the URL can be retrieved and re-copied from the share dialog at any time
 * (it is unguessable — 256 bits of entropy). Tenant isolation for the public read
 * path is anchored entirely on the `ownerId` recorded here — the client never
 * supplies it.
 */

// Scopes that can be shared. Workspace-global explorers (logs/errors) are
// intentionally excluded for now because a single link would expose the entire
// workspace's data; they warrant their own filtered design.
export const SHARE_SCOPE_TYPES = [
  'apm',
  'rum',
  'uptime',
  'database',
  'queue',
  'firebase',
  'task',
  'web',
  'vps',
  'savedview',
  'monitorboard',
] as const;

export type ShareScopeType = (typeof SHARE_SCOPE_TYPES)[number];

export type ShareTimeRangeMode = 'flexible' | 'locked';

export interface IDashboardShare extends Document {
  ownerId: string;            // Workspace owner (uid or org_<id>) — the security anchor.
  createdBy: string;          // User uid that created the link (audit).
  scopeType: ShareScopeType;  // Which kind of dashboard.
  scopeId: string;            // The service / Saved View _id this link is pinned to.
  token: string;              // Unguessable 256-bit capability token (stored for retrieval).
  label?: string;             // Optional human label, e.g. "Q3 board review".
  defaultRange: string;       // Initial time window for flexible shares (e.g. "24h").
  timeRangeMode: ShareTimeRangeMode;
  lockedStart?: Date;         // For timeRangeMode === 'locked'.
  lockedEnd?: Date;
  passwordHash?: string;      // Reserved for optional password protection (phase 2).
  expiresAt?: Date | null;    // null = never expires.
  revokedAt?: Date | null;    // Soft-revoke for audit; enforced in code, never auto-deleted.
  accessCount: number;
  lastAccessedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const DashboardShareSchema = new Schema<IDashboardShare>(
  {
    ownerId: { type: String, required: true, index: true },
    createdBy: { type: String, required: true },
    scopeType: { type: String, enum: SHARE_SCOPE_TYPES, required: true },
    scopeId: { type: String, required: true },
    token: { type: String, required: true, unique: true, index: true },
    label: { type: String, trim: true, maxlength: 120 },
    defaultRange: { type: String, default: '24h' },
    timeRangeMode: { type: String, enum: ['flexible', 'locked'], default: 'flexible' },
    lockedStart: { type: Date },
    lockedEnd: { type: Date },
    // select:false so the reserved hash never leaks through normal queries.
    passwordHash: { type: String, select: false },
    expiresAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    accessCount: { type: Number, default: 0 },
    lastAccessedAt: { type: Date },
  },
  { timestamps: true }
);

// Fast lookup + listing of all shares for a given dashboard within a workspace.
DashboardShareSchema.index({ ownerId: 1, scopeType: 1, scopeId: 1 });

export const DashboardShare = mongoose.model<IDashboardShare>('DashboardShare', DashboardShareSchema);
