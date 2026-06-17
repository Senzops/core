import { Request, Response } from 'express';
import crypto from 'crypto';
import { DashboardShare } from '../../models/DashboardShare';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Resend } from 'resend';
import {
  Organization,
  OrganizationMember,
  OrganizationInvitation,
  ORGANIZATION_RESOURCES,
  OrgRole,
  OrgPermissions,
  IOrganization,
} from '../../models/Organization';
import { Subscription } from '../../models/Subscription';
import { User } from '../../models/User';
import { logger } from '../../utils/logger';

let _resend: Resend | null = null;
const getResend = () => {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
};
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const INVITATION_EXPIRY_HOURS = 48;

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const CreateOrgSchema = z.object({
  name: z.string().min(2).max(100).trim(),
  slug: z.string().min(2).max(50).trim().toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Slug must be lowercase alphanumeric with hyphens, cannot start or end with a hyphen'),
});

const UpdateOrgSchema = z.object({
  name: z.string().min(2).max(100).trim().optional(),
  slug: z.string().min(2).max(50).trim().toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Invalid slug format')
    .optional(),
});

const validRoles: OrgRole[] = ['admin', 'member', 'viewer'];
const validActions = ['read', 'write', 'delete'] as const;

const PermissionsSchema = z.record(
  z.enum(ORGANIZATION_RESOURCES as unknown as [string, ...string[]]),
  z.array(z.enum(validActions))
).optional().default({});

const InviteMemberSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  role: z.enum(['admin', 'member', 'viewer'] as const).default('member'),
  permissions: PermissionsSchema,
});

const UpdateMemberSchema = z.object({
  role: z.enum(['admin', 'member', 'viewer'] as const).optional(),
  permissions: PermissionsSchema,
});

const AcceptInvitationSchema = z.object({
  token: z.string().min(1),
});

// ============================================================================
// ORGANIZATION CRUD
// ============================================================================

export const createOrganization = async (req: Request, res: Response) => {
  try {
    const uid = (req as any).user?.uid;
    const email = (req as any).user?.email;
    if (!uid || !email) return res.status(401).json({ error: 'Missing authentication context.' });

    const { name, slug } = CreateOrgSchema.parse(req.body);

    const existingSlug = await Organization.findOne({ slug }).lean();
    if (existingSlug) {
      return res.status(409).json({ error: 'This slug is already taken. Please choose another.' });
    }

    const orgId = new mongoose.Types.ObjectId();

    const org = await Organization.create({
      _id: orgId,
      slug,
      name,
      createdBy: uid,
      ownerId: `org_${orgId}`,
    });

    await OrganizationMember.create({
      orgId: org._id,
      userId: uid,
      email,
      role: 'owner',
      permissions: {},
      invitedBy: uid,
      joinedAt: new Date(),
    });

    logger.info(`[Organization] Created org '${slug}' (${org._id}) by user ${uid}`);
    res.status(201).json({ organization: { ...org.toObject(), role: 'owner' } });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed.', details: error.errors });
    }
    logger.error(`[Organization] Create failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to create organization.' });
  }
};

export const listOrganizations = async (req: Request, res: Response) => {
  try {
    const uid = (req as any).user?.uid;
    if (!uid) return res.status(401).json({ error: 'Missing authentication context.' });

    const memberships = await OrganizationMember.find({ userId: uid }).lean();
    const orgIds = memberships.map(m => m.orgId);

    const orgs = await Organization.find({ _id: { $in: orgIds } }).lean();

    const result = orgs.map(org => {
      const membership = memberships.find(m => m.orgId.toString() === org._id.toString());
      return { ...org, role: membership?.role };
    });

    res.json({ organizations: result });
  } catch (error: any) {
    logger.error(`[Organization] List failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to list organizations.' });
  }
};

export const getOrganization = async (req: Request, res: Response) => {
  try {
    const uid = (req as any).user?.uid;
    const { orgId } = req.params;
    if (!uid) return res.status(401).json({ error: 'Missing authentication context.' });

    const member = await OrganizationMember.findOne({ orgId, userId: uid }).lean();
    if (!member) return res.status(403).json({ error: 'Access denied.' });

    const org = await Organization.findById(orgId).lean();
    if (!org) return res.status(404).json({ error: 'Organization not found.' });

    const memberCount = await OrganizationMember.countDocuments({ orgId });
    const subscription = await Subscription.findOne({ ownerId: org.ownerId }).lean();

    res.json({
      organization: org,
      role: member.role,
      memberCount,
      subscription,
    });
  } catch (error: any) {
    logger.error(`[Organization] Get failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to get organization.' });
  }
};

export const updateOrganization = async (req: Request, res: Response) => {
  try {
    const uid = (req as any).user?.uid;
    const { orgId } = req.params;
    if (!uid) return res.status(401).json({ error: 'Missing authentication context.' });

    const member = await OrganizationMember.findOne({ orgId, userId: uid }).lean();
    if (!member || !['owner', 'admin'].includes(member.role)) {
      return res.status(403).json({ error: 'Only owners and admins can update the organization.' });
    }

    const updates = UpdateOrgSchema.parse(req.body);

    if (updates.slug) {
      const existingSlug = await Organization.findOne({ slug: updates.slug, _id: { $ne: orgId } }).lean();
      if (existingSlug) {
        return res.status(409).json({ error: 'This slug is already taken.' });
      }
    }

    const org = await Organization.findByIdAndUpdate(orgId, updates, { new: true });
    if (!org) return res.status(404).json({ error: 'Organization not found.' });

    res.json({ organization: org });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed.', details: error.errors });
    }
    logger.error(`[Organization] Update failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to update organization.' });
  }
};

export const deleteOrganization = async (req: Request, res: Response) => {
  try {
    const uid = (req as any).user?.uid;
    const { orgId } = req.params;
    const { confirmSlug } = req.body;
    if (!uid) return res.status(401).json({ error: 'Missing authentication context.' });

    const member = await OrganizationMember.findOne({ orgId, userId: uid }).lean();
    if (!member || member.role !== 'owner') {
      return res.status(403).json({ error: 'Only the organization owner can delete it.' });
    }

    const org = await Organization.findById(orgId).lean();
    if (!org) return res.status(404).json({ error: 'Organization not found.' });

    if (confirmSlug !== org.slug) {
      return res.status(400).json({ error: 'Confirmation slug does not match.' });
    }

    logger.warn(`[Organization] Deleting org '${org.slug}' (${orgId}) by user ${uid}`);

    await Organization.deleteOne({ _id: orgId });
    await OrganizationMember.deleteMany({ orgId });
    await OrganizationInvitation.deleteMany({ orgId });
    await Subscription.deleteOne({ ownerId: org.ownerId });
    // Tear down any public dashboard share links owned by this workspace.
    await DashboardShare.deleteMany({ ownerId: org.ownerId });

    res.json({ message: 'Organization deleted successfully.' });
  } catch (error: any) {
    logger.error(`[Organization] Delete failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to delete organization.' });
  }
};

// ============================================================================
// MEMBER MANAGEMENT
// ============================================================================

export const listMembers = async (req: Request, res: Response) => {
  try {
    const uid = (req as any).user?.uid;
    const { orgId } = req.params;
    if (!uid) return res.status(401).json({ error: 'Missing authentication context.' });

    const member = await OrganizationMember.findOne({ orgId, userId: uid }).lean();
    if (!member) return res.status(403).json({ error: 'Access denied.' });

    const members = await OrganizationMember.find({ orgId }).sort({ joinedAt: 1 }).lean();
    res.json({ members });
  } catch (error: any) {
    logger.error(`[Organization] List members failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to list members.' });
  }
};

export const updateMember = async (req: Request, res: Response) => {
  try {
    const uid = (req as any).user?.uid;
    const { orgId, memberId } = req.params;
    if (!uid) return res.status(401).json({ error: 'Missing authentication context.' });

    const requester = await OrganizationMember.findOne({ orgId, userId: uid }).lean();
    if (!requester || !['owner', 'admin'].includes(requester.role)) {
      return res.status(403).json({ error: 'Insufficient permissions to manage members.' });
    }

    const target = await OrganizationMember.findOne({ _id: memberId, orgId });
    if (!target) return res.status(404).json({ error: 'Member not found.' });

    if (target.role === 'owner') {
      return res.status(403).json({ error: 'Cannot modify the organization owner.' });
    }

    if (requester.role === 'admin' && target.role === 'admin') {
      return res.status(403).json({ error: 'Admins cannot modify other admins.' });
    }

    const updates = UpdateMemberSchema.parse(req.body);

    if ((updates.role as string) === 'owner') {
      return res.status(400).json({ error: 'Cannot assign owner role. Use ownership transfer instead.' });
    }

    if (updates.role) target.role = updates.role;
    if (updates.permissions !== undefined) target.permissions = updates.permissions;

    await target.save();
    res.json({ member: target });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed.', details: error.errors });
    }
    logger.error(`[Organization] Update member failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to update member.' });
  }
};

export const removeMember = async (req: Request, res: Response) => {
  try {
    const uid = (req as any).user?.uid;
    const { orgId, memberId } = req.params;
    if (!uid) return res.status(401).json({ error: 'Missing authentication context.' });

    const requester = await OrganizationMember.findOne({ orgId, userId: uid }).lean();

    const target = await OrganizationMember.findOne({ _id: memberId, orgId }).lean();
    if (!target) return res.status(404).json({ error: 'Member not found.' });

    if (target.role === 'owner') {
      return res.status(403).json({ error: 'Cannot remove the organization owner.' });
    }

    const isSelf = target.userId === uid;
    const isAdminOrOwner = requester && ['owner', 'admin'].includes(requester.role);

    if (!isSelf && !isAdminOrOwner) {
      return res.status(403).json({ error: 'Insufficient permissions to remove members.' });
    }

    if (!isSelf && requester?.role === 'admin' && target.role === 'admin') {
      return res.status(403).json({ error: 'Admins cannot remove other admins.' });
    }

    await OrganizationMember.deleteOne({ _id: memberId, orgId });
    logger.info(`[Organization] Member ${target.email} removed from org ${orgId} by ${uid}`);
    res.json({ message: 'Member removed successfully.' });
  } catch (error: any) {
    logger.error(`[Organization] Remove member failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to remove member.' });
  }
};

// ============================================================================
// INVITATION MANAGEMENT
// ============================================================================

function generateInvitationToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, hash };
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export const sendInvitation = async (req: Request, res: Response) => {
  try {
    const uid = (req as any).user?.uid;
    const { orgId } = req.params;
    if (!uid) return res.status(401).json({ error: 'Missing authentication context.' });

    const requester = await OrganizationMember.findOne({ orgId, userId: uid }).lean();
    if (!requester || !['owner', 'admin'].includes(requester.role)) {
      return res.status(403).json({ error: 'Only owners and admins can send invitations.' });
    }

    const { email, role, permissions } = InviteMemberSchema.parse(req.body);

    if (requester.role === 'admin' && role === 'admin') {
      return res.status(403).json({ error: 'Admins cannot invite other admins. Only owners can.' });
    }

    const existingMember = await OrganizationMember.findOne({ orgId, email }).lean();
    if (existingMember) {
      return res.status(409).json({ error: 'This user is already a member of the organization.' });
    }

    const existingInvitation = await OrganizationInvitation.findOne({ orgId, email, status: 'pending' }).lean();
    if (existingInvitation) {
      return res.status(409).json({ error: 'A pending invitation already exists for this email.' });
    }

    const org = await Organization.findById(orgId).lean();
    if (!org) return res.status(404).json({ error: 'Organization not found.' });

    const { token, hash } = generateInvitationToken();

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + INVITATION_EXPIRY_HOURS);

    await OrganizationInvitation.create({
      orgId,
      email,
      role,
      permissions: permissions || {},
      tokenHash: hash,
      status: 'pending',
      invitedBy: uid,
      expiresAt,
    });

    const inviteUrl = `${FRONTEND_URL}/invite?token=${token}`;
    const requesterUser = await User.findOne({ firebaseUid: uid }).lean();
    const inviterName = requesterUser?.email || 'A team member';

    try {
      await getResend().emails.send({
        from: `Senzor <${process.env.RESEND_FROM_EMAIL || 'noreply@senzor.dev'}>`,
        to: email,
        subject: `You've been invited to join ${org.name} on Senzor`,
        html: buildInvitationEmail(org.name, inviterName, role, inviteUrl, INVITATION_EXPIRY_HOURS),
      });
    } catch (emailError: any) {
      logger.error(`[Organization] Failed to send invitation email to ${email}: ${emailError.message}`);
    }

    logger.info(`[Organization] Invitation sent to ${email} for org ${orgId} by ${uid}`);
    res.status(201).json({ message: 'Invitation sent successfully.' });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed.', details: error.errors });
    }
    logger.error(`[Organization] Send invitation failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to send invitation.' });
  }
};

export const listInvitations = async (req: Request, res: Response) => {
  try {
    const uid = (req as any).user?.uid;
    const { orgId } = req.params;
    if (!uid) return res.status(401).json({ error: 'Missing authentication context.' });

    const member = await OrganizationMember.findOne({ orgId, userId: uid }).lean();
    if (!member || !['owner', 'admin'].includes(member.role)) {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }

    const invitations = await OrganizationInvitation.find({ orgId })
      .sort({ createdAt: -1 })
      .select('-tokenHash')
      .lean();

    res.json({ invitations });
  } catch (error: any) {
    logger.error(`[Organization] List invitations failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to list invitations.' });
  }
};

export const revokeInvitation = async (req: Request, res: Response) => {
  try {
    const uid = (req as any).user?.uid;
    const { orgId, invitationId } = req.params;
    if (!uid) return res.status(401).json({ error: 'Missing authentication context.' });

    const member = await OrganizationMember.findOne({ orgId, userId: uid }).lean();
    if (!member || !['owner', 'admin'].includes(member.role)) {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }

    const invitation = await OrganizationInvitation.findOneAndUpdate(
      { _id: invitationId, orgId, status: 'pending' },
      { status: 'revoked' },
      { new: true }
    );

    if (!invitation) {
      return res.status(404).json({ error: 'Pending invitation not found.' });
    }

    res.json({ message: 'Invitation revoked.' });
  } catch (error: any) {
    logger.error(`[Organization] Revoke invitation failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to revoke invitation.' });
  }
};

export const acceptInvitation = async (req: Request, res: Response) => {
  try {
    const uid = (req as any).user?.uid;
    const email = (req as any).user?.email;
    if (!uid || !email) return res.status(401).json({ error: 'Missing authentication context.' });

    const { token } = AcceptInvitationSchema.parse(req.body);
    const tokenHash = hashToken(token);

    const invitation = await OrganizationInvitation.findOne({ tokenHash, status: 'pending' });
    if (!invitation) {
      return res.status(404).json({ error: 'Invalid or expired invitation.' });
    }

    if (invitation.expiresAt < new Date()) {
      invitation.status = 'expired';
      await invitation.save();
      return res.status(410).json({ error: 'This invitation has expired.' });
    }

    if (invitation.email !== email.toLowerCase()) {
      return res.status(403).json({ error: 'This invitation was sent to a different email address.' });
    }

    const existingMember = await OrganizationMember.findOne({ orgId: invitation.orgId, userId: uid }).lean();
    if (existingMember) {
      invitation.status = 'accepted';
      await invitation.save();
      return res.status(409).json({ error: 'You are already a member of this organization.' });
    }

    await OrganizationMember.create({
      orgId: invitation.orgId,
      userId: uid,
      email,
      role: invitation.role,
      permissions: invitation.permissions || {},
      invitedBy: invitation.invitedBy,
      joinedAt: new Date(),
    });

    invitation.status = 'accepted';
    await invitation.save();

    const org = await Organization.findById(invitation.orgId).lean();

    logger.info(`[Organization] ${email} accepted invitation to org ${invitation.orgId}`);
    res.json({
      message: 'Invitation accepted successfully.',
      organization: org ? { ...org, role: invitation.role } : null,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed.', details: error.errors });
    }
    logger.error(`[Organization] Accept invitation failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to accept invitation.' });
  }
};

export const getInvitationDetails = async (req: Request, res: Response) => {
  try {
    const { token } = req.query;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Missing invitation token.' });
    }

    const tokenHash = hashToken(token);
    const invitation = await OrganizationInvitation.findOne({ tokenHash, status: 'pending' })
      .select('-tokenHash')
      .lean();

    if (!invitation) {
      return res.status(404).json({ error: 'Invalid or expired invitation.' });
    }

    if (invitation.expiresAt < new Date()) {
      return res.status(410).json({ error: 'This invitation has expired.' });
    }

    const org = await Organization.findById(invitation.orgId).select('name slug').lean();

    res.json({
      invitation: {
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
      },
      organization: org,
    });
  } catch (error: any) {
    logger.error(`[Organization] Get invitation details failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to get invitation details.' });
  }
};

// ============================================================================
// OWNERSHIP TRANSFER
// ============================================================================

export const transferOwnership = async (req: Request, res: Response) => {
  try {
    const uid = (req as any).user?.uid;
    const { orgId, memberId } = req.params;
    if (!uid) return res.status(401).json({ error: 'Missing authentication context.' });

    const requester = await OrganizationMember.findOne({ orgId, userId: uid });
    if (!requester || requester.role !== 'owner') {
      return res.status(403).json({ error: 'Only the current owner can transfer ownership.' });
    }

    const target = await OrganizationMember.findOne({ _id: memberId, orgId });
    if (!target) return res.status(404).json({ error: 'Member not found.' });

    if (target.userId === uid) {
      return res.status(400).json({ error: 'You are already the owner.' });
    }

    requester.role = 'admin';
    target.role = 'owner';
    target.permissions = {};

    await requester.save();
    await target.save();

    logger.info(`[Organization] Ownership of org ${orgId} transferred from ${uid} to ${target.userId}`);
    res.json({ message: 'Ownership transferred successfully.' });
  } catch (error: any) {
    logger.error(`[Organization] Transfer ownership failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to transfer ownership.' });
  }
};

// ============================================================================
// EMAIL TEMPLATE
// ============================================================================

function buildInvitationEmail(
  orgName: string,
  inviterName: string,
  role: string,
  inviteUrl: string,
  expiryHours: number
): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0a;padding:40px 20px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background-color:#141414;border:1px solid #262626;border-radius:12px;overflow:hidden;">
        <tr><td style="background:linear-gradient(135deg,#2563eb 0%,#7c3aed 100%);padding:32px 32px 28px;">
          <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:700;">You're invited to join ${orgName}</h1>
          <p style="margin:8px 0 0;color:rgba(255,255,255,0.8);font-size:14px;">${inviterName} has invited you to collaborate</p>
        </td></tr>
        <tr><td style="padding:32px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1a1a;border:1px solid #262626;border-radius:8px;margin-bottom:24px;">
            <tr>
              <td style="padding:16px;border-bottom:1px solid #262626;">
                <span style="color:#a1a1aa;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Organization</span><br>
                <span style="color:#ffffff;font-size:14px;font-weight:600;">${orgName}</span>
              </td>
              <td style="padding:16px;border-bottom:1px solid #262626;">
                <span style="color:#a1a1aa;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Role</span><br>
                <span style="color:#ffffff;font-size:14px;font-weight:600;text-transform:capitalize;">${role}</span>
              </td>
            </tr>
          </table>
          <a href="${inviteUrl}" style="display:block;text-align:center;background-color:#2563eb;color:#ffffff;padding:14px 24px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;">Accept Invitation</a>
          <p style="margin:20px 0 0;color:#71717a;font-size:12px;text-align:center;">This invitation expires in ${expiryHours} hours.</p>
        </td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid #262626;">
          <p style="margin:0;color:#52525b;font-size:11px;text-align:center;">Senzor — Observability Platform</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
