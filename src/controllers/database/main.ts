import { Request, Response, NextFunction } from 'express';
import { MongoClient } from 'mongodb';
import { DatabaseService, DbMetric } from '../../models/Database';
import { encrypt } from '../../utils/crypto';
import { RegisterDbSchema } from '../../utils/validation';

export const registerDatabase = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { name, type, uri, interval } = RegisterDbSchema.parse(req.body);

    // 1. Connection Validation (Fail Fast)
    if (type === 'mongodb') {
      try {
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
        await client.connect();

        // Verify we have admin privileges to read serverStatus
        const adminDb = client.db('admin');
        await adminDb.command({ serverStatus: 1 });
        await client.close();
      } catch (err: any) {
        return res.status(400).json({
          error: 'Database Connection Failed',
          details: 'Please ensure the credentials are correct and the user has the "clusterMonitor" or "root" role.'
        });
      }
    } else {
      return res.status(400).json({ error: `Adapter for ${type} is not yet implemented.` });
    }

    // 2. Encrypt & Save
    const encryptedUri = encrypt(uri);

    const newDb = await DatabaseService.create({
      ownerId: uid,
      name,
      type,
      encryptedUri,
      interval,
      status: 'online',
      lastCheck: new Date()
    });

    res.status(201).json({
      message: 'Database Connected & Registered',
      dbId: newDb._id,
      name: newDb.name,
      type: newDb.type
    });
  } catch (error) {
    next(error);
  }
};

export const listDatabases = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const dbs = await DatabaseService.find({ ownerId: uid })
      .select('-encryptedUri') // NEVER send encrypted URI to frontend
      .sort({ createdAt: -1 });
    res.json(dbs);
  } catch (error) {
    next(error);
  }
};

export const deleteDatabase = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;

    const result = await DatabaseService.findOneAndDelete({ _id: id, ownerId: uid });
    if (!result) return res.status(404).json({ error: 'Database not found' });

    await DbMetric.deleteMany({ dbId: id });

    res.json({ message: 'Database and all metric history deleted' });
  } catch (error) {
    next(error);
  }
};