import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { User } from '../models/User';
import { Subscription } from '../models/Subscription';
import { logger } from '../utils/logger';

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

    logger.warn(`[Account Deletion] Initiating permanent deletion for user: ${ownerId}`);

    // 1. Delete Core Identity & Billing
    await User.deleteOne({ firebaseUid: ownerId });
    await Subscription.deleteOne({ ownerId });

    // 2. Delete Control Plane Configurations
    // This stops all agents/SDKs from authenticating instantly because their API keys are purged.
    const configurationModels = [
      'ApmService', 'RumService', 'TaskService', 'Vps', 'Website', 'Monitor', 'View', 'LogApiKey', 'Transaction'
    ];

    for (const modelName of configurationModels) {
      if (mongoose.models[modelName]) {
        await mongoose.models[modelName].deleteMany({ ownerId });
      }
    }

    // Enterprise Note: Telemetry collections (ApmTrace, Log, RumEvent, TaskRun) are intentionally NOT deleted here.
    // Executing synchronous multi-million row deletions will cause catastrophic write-locks and API timeouts.
    // They are orphaned and will be automatically purged by your MongoDB TTL retention indexes.

    res.json({ message: "Account and configuration plane successfully deleted." });
  } catch (error: any) {
    logger.error(`[Account Deletion] Error: ${error.message}`);
    res.status(500).json({ error: "Failed to delete account. Please contact support." });
  }
};