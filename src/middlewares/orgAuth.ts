import { Request, Response, NextFunction } from 'express';
import { OrganizationMember, OrgResource, OrgAction, ROLE_DEFAULT_PERMISSIONS, OrgPermissions, OrgRole } from '../models/Organization';
import { logger } from '../utils/logger';

export interface OrgContext {
  orgId: string;
  role: OrgRole;
  permissions: OrgPermissions;
  memberId: string;
}

declare global {
  namespace Express {
    interface Request {
      ownerId?: string;
      orgContext?: OrgContext;
    }
  }
}

/**
 * Resolves the workspace context for every authenticated request.
 * If x-org-id header is present, validates membership and sets ownerId to "org_<orgId>".
 * Otherwise, falls back to the personal account (ownerId = user.uid).
 */
export const resolveWorkspace = async (req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).user;
  if (!user?.uid) {
    return res.status(401).json({ error: 'Unauthorized: Missing user context.' });
  }

  const orgId = req.headers['x-org-id'] as string;

  if (!orgId) {
    (req as any).ownerId = user.uid;
    return next();
  }

  // Demo users get read-only access to any org workspace without membership check.
  // The authenticateUser middleware already restricts demo to GET-only, so this is safe.
  if (user.isDemo) {
    (req as any).ownerId = `org_${orgId}`;
    (req as any).orgContext = {
      orgId,
      role: 'viewer' as OrgRole,
      permissions: {},
      memberId: 'demo',
    };
    return next();
  }

  try {
    const member = await OrganizationMember.findOne({ orgId, userId: user.uid }).lean();

    if (!member) {
      return res.status(403).json({ error: 'Access denied: You are not a member of this organization.' });
    }

    (req as any).ownerId = `org_${orgId}`;
    (req as any).orgContext = {
      orgId,
      role: member.role,
      permissions: member.permissions || {},
      memberId: member._id.toString(),
    };

    next();
  } catch (error: any) {
    logger.error(`[OrgAuth] Failed to resolve workspace: ${error.message}`);
    return res.status(500).json({ error: 'Failed to resolve organization context.' });
  }
};

/**
 * Returns effective permissions for a member by merging role defaults with explicit overrides.
 * Explicit permissions fully replace the role default for that resource.
 */
function getEffectivePermissions(role: OrgRole, overrides: OrgPermissions): OrgPermissions {
  const defaults = ROLE_DEFAULT_PERMISSIONS[role];
  const effective: OrgPermissions = { ...defaults };

  for (const [resource, actions] of Object.entries(overrides)) {
    if (Array.isArray(actions)) {
      effective[resource as OrgResource] = actions;
    }
  }

  return effective;
}

/**
 * Middleware factory that checks if the current user has permission to perform
 * a specific action on a specific resource within the organization context.
 * For personal accounts (no org context), all actions are allowed.
 */
export const requirePermission = (resource: OrgResource, action: OrgAction) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const orgContext = (req as any).orgContext as OrgContext | undefined;

    if (!orgContext) {
      return next();
    }

    const effective = getEffectivePermissions(orgContext.role, orgContext.permissions);
    const allowed = effective[resource];

    if (!allowed || !allowed.includes(action)) {
      return res.status(403).json({
        error: 'Permission denied.',
        details: `Your role '${orgContext.role}' does not have '${action}' permission on '${resource}'.`,
        code: 'PERMISSION_DENIED',
      });
    }

    next();
  };
};
