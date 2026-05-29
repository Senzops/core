import mongoose, { Schema, Document } from 'mongoose';
import { Subscription } from './Subscription';
import { logger } from '../utils/logger';

// ============================================================================
// PERMISSION SYSTEM TYPES
// ============================================================================

export const ORGANIZATION_RESOURCES = [
  'servers', 'apm', 'rum', 'tasks', 'databases', 'monitors',
  'web', 'logs', 'errors', 'alerts', 'views', 'mcp', 'billing',
] as const;

export type OrgResource = typeof ORGANIZATION_RESOURCES[number];
export type OrgAction = 'read' | 'write' | 'delete';
export type OrgPermissions = Partial<Record<OrgResource, OrgAction[]>>;

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';

export const ROLE_DEFAULT_PERMISSIONS: Record<OrgRole, OrgPermissions> = {
  owner: Object.fromEntries(ORGANIZATION_RESOURCES.map(r => [r, ['read', 'write', 'delete']])) as OrgPermissions,
  admin: Object.fromEntries(
    ORGANIZATION_RESOURCES.filter(r => r !== 'billing').map(r => [r, ['read', 'write', 'delete']])
  ) as OrgPermissions,
  member: Object.fromEntries(
    ORGANIZATION_RESOURCES.filter(r => r !== 'billing').map(r => [r, ['read', 'write']])
  ) as OrgPermissions,
  viewer: Object.fromEntries(
    ORGANIZATION_RESOURCES.filter(r => r !== 'billing').map(r => [r, ['read']])
  ) as OrgPermissions,
};

// ============================================================================
// ORGANIZATION MODEL
// ============================================================================

export interface IOrganization extends Document {
  slug: string;
  name: string;
  createdBy: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}

const OrganizationSchema = new Schema<IOrganization>({
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  createdBy: { type: String, required: true, index: true },
  ownerId: { type: String, required: true, unique: true },
}, { timestamps: true });

OrganizationSchema.post('save', async function (doc) {
  try {
    const exists = await Subscription.exists({ ownerId: doc.ownerId });
    if (exists) return;

    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);

    await Subscription.create({
      ownerId: doc.ownerId,
      planId: 'starter',
      status: 'active',
      provider: 'none',
      billingInterval: 'monthly',
      startedAt: new Date(),
      currentMonthBytes: 0,
      quotaResetAt: nextMonth,
      billingCycleReset: nextMonth,
    });

    logger.info(`[Billing] Provisioned 'starter' subscription for organization: ${doc.ownerId}`);
  } catch (error: any) {
    logger.error(`[Billing] CRITICAL: Failed to provision subscription for org ${doc.ownerId}: ${error.message}`);
  }
});

export const Organization = mongoose.model<IOrganization>('Organization', OrganizationSchema);

// ============================================================================
// ORGANIZATION MEMBER MODEL
// ============================================================================

export interface IOrganizationMember extends Document {
  orgId: mongoose.Types.ObjectId;
  userId: string;
  email: string;
  role: OrgRole;
  permissions: OrgPermissions;
  joinedAt: Date;
  invitedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const OrganizationMemberSchema = new Schema<IOrganizationMember>({
  orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  userId: { type: String, required: true, index: true },
  email: { type: String, required: true },
  role: { type: String, enum: ['owner', 'admin', 'member', 'viewer'], required: true, default: 'member' },
  permissions: { type: Schema.Types.Mixed, default: {} },
  joinedAt: { type: Date, default: Date.now },
  invitedBy: { type: String, required: true },
}, { timestamps: true });

OrganizationMemberSchema.index({ orgId: 1, userId: 1 }, { unique: true });
OrganizationMemberSchema.index({ orgId: 1, email: 1 });

export const OrganizationMember = mongoose.model<IOrganizationMember>('OrganizationMember', OrganizationMemberSchema);

// ============================================================================
// ORGANIZATION INVITATION MODEL
// ============================================================================

export interface IOrganizationInvitation extends Document {
  orgId: mongoose.Types.ObjectId;
  email: string;
  role: OrgRole;
  permissions: OrgPermissions;
  tokenHash: string;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  invitedBy: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const OrganizationInvitationSchema = new Schema<IOrganizationInvitation>({
  orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  role: { type: String, enum: ['admin', 'member', 'viewer'], required: true, default: 'member' },
  permissions: { type: Schema.Types.Mixed, default: {} },
  tokenHash: { type: String, required: true, unique: true },
  status: { type: String, enum: ['pending', 'accepted', 'expired', 'revoked'], required: true, default: 'pending' },
  invitedBy: { type: String, required: true },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

OrganizationInvitationSchema.index({ orgId: 1, email: 1 });
OrganizationInvitationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OrganizationInvitation = mongoose.model<IOrganizationInvitation>('OrganizationInvitation', OrganizationInvitationSchema);
