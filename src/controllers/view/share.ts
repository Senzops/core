import { Request, Response } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { z } from 'zod';
import { DashboardShare, SHARE_SCOPE_TYPES, ShareScopeType } from '../../models/DashboardShare';
import { hashShareToken } from '../../middlewares/shareAuth';
import { SavedView, ViewWidget } from '../../models/View';
import { buildAndExecutePipeline } from './engine';
import { getEffectivePermissions } from '../../middlewares/orgAuth';
import { OrgResource } from '../../models/Organization';
import { logger } from '../../utils/logger';

// Telemetry / view models used to verify resource ownership and resolve a
// display name for a share. Imported directly (type-safe) rather than via the
// mongoose registry.
import { ApmService } from '../../models/Apm';
import { RumService } from '../../models/Rum';
import { Monitor } from '../../models/Monitor';
import { DatabaseService } from '../../models/Database';
import { FirebaseService } from '../../models/Firebase';
import { TaskService } from '../../models/Task';
import { Website } from '../../models/Web';
import { Vps } from '../../models/Vps';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Maps a share scope to the model that owns the resource, plus the field that
// holds its human-readable name.
const SCOPE_MODELS: Record<ShareScopeType, { model: mongoose.Model<any>; nameField: string }> = {
  apm: { model: ApmService, nameField: 'name' },
  rum: { model: RumService, nameField: 'name' },
  uptime: { model: Monitor, nameField: 'name' },
  database: { model: DatabaseService, nameField: 'name' },
  firebase: { model: FirebaseService, nameField: 'name' },
  task: { model: TaskService, nameField: 'name' },
  web: { model: Website, nameField: 'name' },
  vps: { model: Vps, nameField: 'name' },
  savedview: { model: SavedView, nameField: 'name' },
};

// Maps a share scope to the organization permission resource it falls under, so
// org members without write access on that resource can't mint public links.
// Scopes with no matching org resource (e.g. firebase) rely on workspace
// membership alone, which resolveWorkspace already enforces.
const SCOPE_ORG_RESOURCE: Partial<Record<ShareScopeType, OrgResource>> = {
  apm: 'apm',
  rum: 'rum',
  uptime: 'monitors',
  database: 'databases',
  task: 'tasks',
  web: 'web',
  vps: 'servers',
  savedview: 'views',
};

const DEFAULT_EXPIRY_DAYS = 30;
const MAX_SHARES_PER_DASHBOARD = 25;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function generateShareToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, tokenHash: hashShareToken(token) };
}

function computeExpiry(expiresInDays: number | null | undefined): Date | null {
  if (expiresInDays === null) return null; // explicit "never"
  const days = expiresInDays === undefined ? DEFAULT_EXPIRY_DAYS : expiresInDays;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

// Strips secret/internal fields before returning a share to the owner's UI.
function sanitizeShare(share: any) {
  const status = share.revokedAt
    ? 'revoked'
    : share.expiresAt && new Date(share.expiresAt).getTime() < Date.now()
      ? 'expired'
      : 'active';

  return {
    id: share._id,
    scopeType: share.scopeType,
    scopeId: share.scopeId,
    label: share.label || null,
    defaultRange: share.defaultRange,
    timeRangeMode: share.timeRangeMode,
    lockedStart: share.lockedStart || null,
    lockedEnd: share.lockedEnd || null,
    expiresAt: share.expiresAt || null,
    status,
    accessCount: share.accessCount || 0,
    lastAccessedAt: share.lastAccessedAt || null,
    createdAt: share.createdAt,
    updatedAt: share.updatedAt,
  };
}

async function verifyResourceOwnership(scopeType: ShareScopeType, scopeId: string, ownerId: string) {
  if (!mongoose.isValidObjectId(scopeId)) return null;
  const { model } = SCOPE_MODELS[scopeType];
  return model.findOne({ _id: scopeId, ownerId }).lean();
}

// In an org workspace, managing share links requires write access on the scope's
// resource. Personal accounts and scopes without a mapped resource are allowed.
function canManageShare(req: Request, scopeType: ShareScopeType): boolean {
  const orgContext = (req as any).orgContext;
  if (!orgContext) return true;
  const resource = SCOPE_ORG_RESOURCE[scopeType];
  if (!resource) return true;
  const effective = getEffectivePermissions(orgContext.role, orgContext.permissions);
  return !!effective[resource]?.includes('write');
}

// ----------------------------------------------------------------------------
// 1. MANAGEMENT (authenticated)
// ----------------------------------------------------------------------------

const CreateShareSchema = z
  .object({
    scopeType: z.enum(SHARE_SCOPE_TYPES),
    scopeId: z.string().min(1),
    label: z.string().trim().max(120).optional(),
    defaultRange: z.string().max(20).optional(),
    timeRangeMode: z.enum(['flexible', 'locked']).optional(),
    lockedStart: z.string().datetime().optional(),
    lockedEnd: z.string().datetime().optional(),
    // number of days until expiry; null = never; omitted = default (30d)
    expiresInDays: z.number().int().positive().max(3650).nullable().optional(),
  })
  .refine(
    (d) => d.timeRangeMode !== 'locked' || (d.lockedStart && d.lockedEnd),
    { message: 'Locked shares require lockedStart and lockedEnd.' }
  );

export const createShare = async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).ownerId;
    const uid = (req as any).user?.uid;
    if (!ownerId || !uid) return res.status(401).json({ error: 'Authentication required.' });

    const parsed = CreateShareSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request.', details: parsed.error.flatten() });
    }
    const body = parsed.data;

    if (!canManageShare(req, body.scopeType)) {
      return res.status(403).json({ error: 'You do not have permission to share this dashboard.', code: 'PERMISSION_DENIED' });
    }

    // 1. The caller must own the dashboard they're sharing.
    const resource = await verifyResourceOwnership(body.scopeType, body.scopeId, ownerId);
    if (!resource) {
      return res.status(404).json({ error: 'Dashboard not found or you do not have access to it.' });
    }

    // 2. Guard against unbounded link creation per dashboard.
    const activeCount = await DashboardShare.countDocuments({
      ownerId,
      scopeType: body.scopeType,
      scopeId: body.scopeId,
      revokedAt: null,
    });
    if (activeCount >= MAX_SHARES_PER_DASHBOARD) {
      return res.status(409).json({
        error: `This dashboard already has the maximum of ${MAX_SHARES_PER_DASHBOARD} active share links. Revoke one to create another.`,
        code: 'SHARE_LIMIT_REACHED',
      });
    }

    const { token, tokenHash } = generateShareToken();

    const share = await DashboardShare.create({
      ownerId,
      createdBy: uid,
      scopeType: body.scopeType,
      scopeId: body.scopeId,
      tokenHash,
      label: body.label,
      defaultRange: body.defaultRange || '24h',
      timeRangeMode: body.timeRangeMode || 'flexible',
      lockedStart: body.lockedStart ? new Date(body.lockedStart) : undefined,
      lockedEnd: body.lockedEnd ? new Date(body.lockedEnd) : undefined,
      expiresAt: computeExpiry(body.expiresInDays),
    });

    logger.info(`[Share] Created ${body.scopeType} share ${share._id} for ${body.scopeId} by ${uid}`);

    // The raw token is returned exactly once — it is never stored or retrievable again.
    res.status(201).json({
      share: sanitizeShare(share.toObject()),
      token,
      url: `${FRONTEND_URL}/shared/${token}`,
    });
  } catch (error: any) {
    logger.error(`[Share] Create failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to create share link.' });
  }
};

export const listShares = async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).ownerId;
    if (!ownerId) return res.status(401).json({ error: 'Authentication required.' });

    const { scopeType, scopeId, includeRevoked } = req.query;

    const filter: any = { ownerId };
    if (scopeType) filter.scopeType = scopeType;
    if (scopeId) filter.scopeId = scopeId;
    if (includeRevoked !== 'true') filter.revokedAt = null;

    const shares = await DashboardShare.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ shares: shares.map(sanitizeShare) });
  } catch (error: any) {
    logger.error(`[Share] List failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to list share links.' });
  }
};

const UpdateShareSchema = z.object({
  label: z.string().trim().max(120).nullable().optional(),
  defaultRange: z.string().max(20).optional(),
  timeRangeMode: z.enum(['flexible', 'locked']).optional(),
  expiresInDays: z.number().int().positive().max(3650).nullable().optional(),
});

export const updateShare = async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).ownerId;
    if (!ownerId) return res.status(401).json({ error: 'Authentication required.' });

    const { id } = req.params;
    const parsed = UpdateShareSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request.', details: parsed.error.flatten() });
    }

    const existing = await DashboardShare.findOne({ _id: id, ownerId, revokedAt: null });
    if (!existing) return res.status(404).json({ error: 'Share link not found.' });
    if (!canManageShare(req, existing.scopeType)) {
      return res.status(403).json({ error: 'You do not have permission to manage this share.', code: 'PERMISSION_DENIED' });
    }

    if (parsed.data.label !== undefined) existing.label = parsed.data.label ?? undefined;
    if (parsed.data.defaultRange !== undefined) existing.defaultRange = parsed.data.defaultRange;
    if (parsed.data.timeRangeMode !== undefined) existing.timeRangeMode = parsed.data.timeRangeMode;
    if (parsed.data.expiresInDays !== undefined) existing.expiresAt = computeExpiry(parsed.data.expiresInDays);

    await existing.save();
    res.json({ share: sanitizeShare(existing.toObject()) });
  } catch (error: any) {
    logger.error(`[Share] Update failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to update share link.' });
  }
};

// Soft-revoke: keeps the record (and its access stats) for audit, while
// immediately disabling the public link.
export const revokeShare = async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).ownerId;
    if (!ownerId) return res.status(401).json({ error: 'Authentication required.' });

    const { id } = req.params;
    const existing = await DashboardShare.findOne({ _id: id, ownerId, revokedAt: null });
    if (!existing) return res.status(404).json({ error: 'Share link not found.' });
    if (!canManageShare(req, existing.scopeType)) {
      return res.status(403).json({ error: 'You do not have permission to revoke this share.', code: 'PERMISSION_DENIED' });
    }

    existing.revokedAt = new Date();
    await existing.save();
    logger.info(`[Share] Revoked share ${id} by ${(req as any).user?.uid}`);
    res.json({ success: true });
  } catch (error: any) {
    logger.error(`[Share] Revoke failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to revoke share link.' });
  }
};

// ----------------------------------------------------------------------------
// 2. PUBLIC (unauthenticated, via resolveShareContext)
// ----------------------------------------------------------------------------

// Returns just enough for the public page to render its chrome and route to the
// right dashboard component. Never exposes ownerId, tokenHash or internal config.
export const getSharedMeta = async (req: Request, res: Response) => {
  try {
    const share = req.share!;
    const ownerId = (req as any).ownerId;

    const { model, nameField } = SCOPE_MODELS[share.scopeType];
    const resource = await model.findOne({ _id: share.scopeId, ownerId }).select(nameField).lean();

    if (!resource) {
      return res.status(404).json({ error: 'The shared dashboard is no longer available.' });
    }

    res.json({
      scopeType: share.scopeType,
      scopeId: share.scopeId,
      name: (resource as any)[nameField] || 'Dashboard',
      label: share.label || null,
      defaultRange: share.defaultRange,
      timeRangeMode: share.timeRangeMode,
      lockedStart: share.lockedStart || null,
      lockedEnd: share.lockedEnd || null,
      expiresAt: share.expiresAt || null,
    });
  } catch (error: any) {
    logger.error(`[Share] Meta failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to load shared dashboard.' });
  }
};

// Public Saved View payload — widget MQL queries are stripped so a viewer never
// sees the underlying filter logic, only what's needed to render.
export const getSharedView = async (req: Request, res: Response) => {
  try {
    const share = req.share!;
    const ownerId = (req as any).ownerId;

    const view = await SavedView.findOne({ _id: share.scopeId, ownerId }).lean();
    if (!view) return res.status(404).json({ error: 'Saved View not found.' });

    const widgets = await ViewWidget.find({ viewId: share.scopeId, ownerId }).lean();
    const safeWidgets = widgets.map((w) => ({
      _id: w._id,
      viewId: w.viewId,
      name: w.name,
      target: w.target,
      visualization: w.visualization,
      config: w.config,
      // `query` intentionally omitted.
    }));

    res.json({ view, widgets: safeWidgets });
  } catch (error: any) {
    logger.error(`[Share] View failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to load shared view.' });
  }
};

// Executes a single widget belonging to the shared view, reusing the exact same
// pipeline as the authenticated path. The widget is verified to belong to the
// pinned view, and the query runs under the share's ownerId.
export const getSharedWidgetData = async (req: Request, res: Response) => {
  try {
    const share = req.share!;
    const ownerId = (req as any).ownerId;
    const { widgetId } = req.params;
    const { range, start, end } = req.query;

    const widget = await ViewWidget.findOne({
      _id: widgetId,
      ownerId,
      viewId: share.scopeId,
    }).lean();
    if (!widget) return res.status(404).json({ error: 'Widget not found.' });

    const data = await buildAndExecutePipeline(
      ownerId,
      widget.target,
      { range: range as string, start: start as string, end: end as string },
      widget.query
    );

    res.json({ data });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to fetch widget data.' });
  }
};
