import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { User } from '../models/User';
import { Subscription } from '../models/Subscription';
import { OrganizationMember } from '../models/Organization';
import { logger } from '../utils/logger';

/**
 * POST /api/user/sync
 * JIT Identity Synchronization. Called transparently by the frontend
 * upon Firebase session resolution to guarantee DB presence.
 */
export const syncUser = async (req: Request, res: Response) => {
  try {
    const uid = (req as any).user?.uid;
    const email = (req as any).user?.email;

    if (!uid || !email) {
      return res.status(401).json({ error: "Missing authentication context." });
    }

    // Fire-and-forget upsert. If they exist, this resolves in ~2ms.
    // If they are new, it creates them and triggers the Subscription Mongoose hook.
    await User.findOneAndUpdate(
      { firebaseUid: uid },
      { firebaseUid: uid, email },
      { upsert: true, new: true }
    );

    res.status(200).json({ synced: true });
  } catch (error: any) {
    logger.error(`[Identity Sync] Failed to sync user context: ${error.message}`);
    // We return 200 anyway so a minor DB blip doesn't break the frontend login flow
    res.status(200).json({ synced: false, error: "Sync deferred" });
  }
};

/**
 * DELETE /api/user/account
 * Permanently purges user identity, billing data, and configuration plane.
 */
export const deleteAccount = async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).user?.uid;
    const userEmail = (req as any).user?.email;
    const { confirmEmail } = req.body;

    // Security Check: Enforce intent verification
    if (confirmEmail !== userEmail) {
      return res.status(400).json({ error: "Confirmation email does not match." });
    }

    // Block deletion if user owns any organizations — ownership must be transferred first
    const ownedOrgs = await OrganizationMember.find({ userId: ownerId, role: 'owner' })
      .select('orgId')
      .populate('orgId', 'name')
      .lean();

    if (ownedOrgs.length > 0) {
      const orgNames = ownedOrgs.map((m: any) => m.orgId?.name || 'Unknown').join(', ');
      return res.status(409).json({
        error: 'Cannot delete account while you own organizations.',
        details: `Transfer ownership or delete these organizations first: ${orgNames}`,
        code: 'ORG_OWNER_BLOCK',
        organizations: ownedOrgs.map((m: any) => ({ orgId: m.orgId?._id, name: m.orgId?.name })),
      });
    }

    logger.warn(`[Account Deletion] Initiating permanent deletion for user: ${ownerId}`);

    // 1. Delete Core Identity & Billing
    await User.deleteOne({ firebaseUid: ownerId });
    await Subscription.deleteOne({ ownerId });

    // 2. Delete Control Plane Configurations
    // This stops all agents/SDKs from authenticating instantly because their API keys are purged.
    const configurationModels = [
      'ApmService', 'RumService', 'TaskService', 'Vps', 'Website', 'Monitor',
      'DatabaseService', 'SavedView', 'ViewWidget', 'LogApiKey', 'McpApiKey', 'McpUsage',
      'AlertDestination', 'AlertPolicy', 'AlertCondition', 'AlertIncident', 'AlertSilence',
      'MonitorIncident', 'ErrorGroup', 'Transaction',
    ];

    for (const modelName of configurationModels) {
      if (mongoose.models[modelName]) {
        await mongoose.models[modelName].deleteMany({ ownerId });
      }
    }

    // 3. Remove user from all organizations they are a member of (non-owner, since owners are blocked above)
    await OrganizationMember.deleteMany({ userId: ownerId });

    // Enterprise Note: Telemetry collections (ApmTrace, Log, RumEvent, TaskRun) are intentionally NOT deleted here.
    // Executing synchronous multi-million row deletions will cause catastrophic write-locks and API timeouts.
    // They are orphaned and will be automatically purged by your MongoDB TTL retention indexes.

    res.json({ message: "Account and configuration plane successfully deleted." });
  } catch (error: any) {
    logger.error(`[Account Deletion] Error: ${error.message}`);
    res.status(500).json({ error: "Failed to delete account. Please contact support." });
  }
};