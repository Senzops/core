import { Request, Response, NextFunction } from 'express';
import admin from 'firebase-admin';
import { FirebaseService, FirebaseMetric, FirebaseAuthSnapshot } from '../../models/Firebase';
import { encrypt } from '../../utils/crypto';
import { removeApp as invalidateWorkerPool } from '../../worker/firebase';
import { z } from 'zod';

const RegisterFirebaseSchema = z.object({
  name: z.string().min(1).max(50),
  serviceAccount: z.string().min(1),
  interval: z.number().min(5).max(60).default(15)
});

const UpdateFirebaseSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  serviceAccount: z.string().min(1).optional(),
  interval: z.number().min(5).max(60).optional()
});

function validateServiceAccount(raw: string): { projectId: string; parsed: any } {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON: service account must be valid JSON');
  }

  if (parsed.type !== 'service_account') {
    throw new Error('Invalid credential: "type" must be "service_account"');
  }
  if (!parsed.project_id || typeof parsed.project_id !== 'string') {
    throw new Error('Invalid credential: missing "project_id"');
  }
  if (!parsed.private_key || typeof parsed.private_key !== 'string') {
    throw new Error('Invalid credential: missing "private_key"');
  }
  if (!parsed.client_email || typeof parsed.client_email !== 'string') {
    throw new Error('Invalid credential: missing "client_email"');
  }

  return { projectId: parsed.project_id, parsed };
}

export const registerFirebase = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { name, serviceAccount, interval } = RegisterFirebaseSchema.parse(req.body);

    let validationResult: { projectId: string; parsed: any };
    try {
      validationResult = validateServiceAccount(serviceAccount);
    } catch (err: any) {
      return res.status(400).json({ error: 'Invalid Service Account', details: err.message });
    }
    const { projectId, parsed } = validationResult;

    let testApp: admin.app.App | null = null;
    try {
      const appName = `validation-${Date.now()}`;
      testApp = admin.initializeApp(
        { credential: admin.credential.cert(parsed) },
        appName
      );
      await testApp.auth().listUsers(1);
    } catch (err: any) {
      return res.status(400).json({
        error: 'Firebase Connection Failed',
        details: err.message || 'Could not authenticate with the provided service account'
      });
    } finally {
      if (testApp) await testApp.delete().catch(() => {});
    }

    const encryptedServiceAccount = encrypt(serviceAccount);

    const newService = await FirebaseService.create({
      ownerId,
      name,
      projectId,
      encryptedServiceAccount,
      interval,
      status: 'online',
      lastCheck: new Date()
    });

    res.status(201).json({
      message: 'Firebase Project Connected',
      serviceId: newService._id,
      name: newService.name,
      projectId: newService.projectId
    });
  } catch (error) {
    next(error);
  }
};

export const listFirebaseServices = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const services = await FirebaseService.find({ ownerId })
      .select('-encryptedServiceAccount')
      .sort({ createdAt: -1 });
    res.json(services);
  } catch (error) {
    next(error);
  }
};

export const updateFirebase = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const updates = UpdateFirebaseSchema.parse(req.body);

    const existing = await FirebaseService.findOne({ _id: id, ownerId });
    if (!existing) return res.status(404).json({ error: 'Firebase service not found' });

    const updateFields: Record<string, any> = {};
    if (updates.name !== undefined) updateFields.name = updates.name;
    if (updates.interval !== undefined) updateFields.interval = updates.interval;

    if (updates.serviceAccount !== undefined) {
      let validationResult: { projectId: string; parsed: any };
      try {
        validationResult = validateServiceAccount(updates.serviceAccount);
      } catch (err: any) {
        return res.status(400).json({ error: 'Invalid Service Account', details: err.message });
      }
      const { projectId, parsed } = validationResult;

      let testApp: admin.app.App | null = null;
      try {
        const appName = `validation-update-${Date.now()}`;
        testApp = admin.initializeApp(
          { credential: admin.credential.cert(parsed) },
          appName
        );
        await testApp.auth().listUsers(1);
      } catch (err: any) {
        return res.status(400).json({
          error: 'Firebase Connection Failed',
          details: err.message || 'Could not authenticate with the provided service account'
        });
      } finally {
        if (testApp) await testApp.delete().catch(() => {});
      }

      updateFields.encryptedServiceAccount = encrypt(updates.serviceAccount);
      updateFields.projectId = projectId;
      updateFields.status = 'online';
      updateFields.lastCheck = new Date();
      updateFields.errorMessage = undefined;

      invalidateWorkerPool(id);
    }

    const updated = await FirebaseService.findOneAndUpdate(
      { _id: id, ownerId },
      updateFields,
      { new: true, runValidators: true }
    ).select('-encryptedServiceAccount');

    res.json({ message: 'Firebase Service Updated', service: updated });
  } catch (error) {
    next(error);
  }
};

export const deleteFirebase = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const result = await FirebaseService.findOneAndDelete({ _id: id, ownerId });
    if (!result) return res.status(404).json({ error: 'Firebase service not found' });

    invalidateWorkerPool(id);

    await Promise.all([
      FirebaseMetric.deleteMany({ serviceId: id }),
      FirebaseAuthSnapshot.deleteOne({ serviceId: id })
    ]);

    res.json({ message: 'Firebase service and all metric history deleted' });
  } catch (error) {
    next(error);
  }
};
