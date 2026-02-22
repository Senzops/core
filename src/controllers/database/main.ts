import { Request, Response, NextFunction } from 'express';
import { MongoClient } from 'mongodb';
import Redis from 'ioredis';
import { DatabaseService, DbMetric, DbCollectionStat } from '../../models/Database';
import { encrypt } from '../../utils/crypto';
import { z } from 'zod';

const RegisterDbSchema = z.object({
  name: z.string().min(1).max(50),
  type: z.enum(['mongodb', 'postgresql', 'mysql', 'redis']),
  uri: z.string(), // Removed strict .url() validation because redis strings can lack standard URL formatting
  interval: z.number().min(1).max(60).default(5)
});

export const registerDatabase = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { name, type, uri, interval } = RegisterDbSchema.parse(req.body);

    if (type === 'mongodb') {
      try {
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
        await client.connect();
        const adminDb = client.db('admin');
        await adminDb.command({ serverStatus: 1 });
        await client.close();
      } catch (err: any) {
        return res.status(400).json({ error: 'MongoDB Connection Failed', details: err.message });
      }
    } else if (type === 'redis') {
      try {
        const redis = new Redis(uri, {
          maxRetriesPerRequest: 1,
          connectTimeout: 5000,
          lazyConnect: true // Prevent immediate connection throw
        });
        await redis.connect();
        await redis.ping();
        await redis.quit();
      } catch (err: any) {
        return res.status(400).json({ error: 'Redis Connection Failed', details: err.message });
      }
    } else {
      return res.status(400).json({ error: `Adapter for ${type} is not yet implemented.` });
    }

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

    res.status(201).json({ message: 'Database Connected & Registered', dbId: newDb._id, name: newDb.name, type: newDb.type });
  } catch (error) {
    next(error);
  }
};

export const listDatabases = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const dbs = await DatabaseService.find({ ownerId: uid }).select('-encryptedUri').sort({ createdAt: -1 });
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
    await DbCollectionStat.deleteOne({ dbId: id });

    res.json({ message: 'Database and all metric history deleted' });
  } catch (error) {
    next(error);
  }
};