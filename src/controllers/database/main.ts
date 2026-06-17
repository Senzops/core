import { Request, Response, NextFunction } from 'express';
import { MongoClient } from 'mongodb';
import Redis from 'ioredis';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { DatabaseService, DbMetric, DbCollectionStat } from '../../models/Database';
import { DashboardShare } from '../../models/DashboardShare';
import { encrypt } from '../../utils/crypto';
import { UpdateDbSchema } from '../../utils/validation';
import { z } from 'zod';

const RegisterDbSchema = z.object({
  name: z.string().min(1).max(50),
  type: z.enum(['mongodb', 'postgresql', 'mysql', 'redis']),
  uri: z.string(), // Removed strict .url() validation because redis strings can lack standard URL formatting
  interval: z.number().min(1).max(60).default(5)
});

export const registerDatabase = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
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
    } else if (type === 'postgresql') {
      let client: pg.Client | null = null;
      try {
        client = new pg.Client({ connectionString: uri, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
        await client.connect();
        await client.query('SELECT 1');
      } catch (err: any) {
        return res.status(400).json({ error: 'PostgreSQL Connection Failed', details: err.message });
      } finally {
        if (client) await client.end().catch(() => {});
      }
    } else if (type === 'mysql') {
      let conn: mysql.Connection | null = null;
      try {
        conn = await mysql.createConnection({ uri, connectTimeout: 5000 });
        await conn.query('SELECT 1');
      } catch (err: any) {
        return res.status(400).json({ error: 'MySQL Connection Failed', details: err.message });
      } finally {
        if (conn) await conn.end().catch(() => {});
      }
    } else {
      return res.status(400).json({ error: `Adapter for ${type} is not yet implemented.` });
    }

    const encryptedUri = encrypt(uri);

    const newDb = await DatabaseService.create({
      ownerId,
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
    const ownerId = (req as any).ownerId;
    const dbs = await DatabaseService.find({ ownerId }).select('-encryptedUri').sort({ createdAt: -1 });
    res.json(dbs);
  } catch (error) {
    next(error);
  }
};

export const updateDatabase = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const updates = UpdateDbSchema.parse(req.body);

    const existing = await DatabaseService.findOne({ _id: id, ownerId });
    if (!existing) return res.status(404).json({ error: 'Database not found' });

    const updateFields: Record<string, any> = {};
    if (updates.name !== undefined) updateFields.name = updates.name;
    if (updates.interval !== undefined) updateFields.interval = updates.interval;

    const effectiveType = updates.type || existing.type;
    if (updates.type !== undefined) updateFields.type = updates.type;

    if (updates.uri !== undefined) {
      if (effectiveType === 'mongodb') {
        try {
          const client = new MongoClient(updates.uri, { serverSelectionTimeoutMS: 5000 });
          await client.connect();
          const adminDb = client.db('admin');
          await adminDb.command({ serverStatus: 1 });
          await client.close();
        } catch (err: any) {
          return res.status(400).json({ error: 'MongoDB Connection Failed', details: err.message });
        }
      } else if (effectiveType === 'redis') {
        try {
          const redis = new Redis(updates.uri, {
            maxRetriesPerRequest: 1,
            connectTimeout: 5000,
            lazyConnect: true,
          });
          await redis.connect();
          await redis.ping();
          await redis.quit();
        } catch (err: any) {
          return res.status(400).json({ error: 'Redis Connection Failed', details: err.message });
        }
      } else if (effectiveType === 'postgresql') {
        let client: pg.Client | null = null;
        try {
          client = new pg.Client({ connectionString: updates.uri, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
          await client.connect();
          await client.query('SELECT 1');
        } catch (err: any) {
          return res.status(400).json({ error: 'PostgreSQL Connection Failed', details: err.message });
        } finally {
          if (client) await client.end().catch(() => {});
        }
      } else if (effectiveType === 'mysql') {
        let conn: mysql.Connection | null = null;
        try {
          conn = await mysql.createConnection({ uri: updates.uri, connectTimeout: 5000 });
          await conn.query('SELECT 1');
        } catch (err: any) {
          return res.status(400).json({ error: 'MySQL Connection Failed', details: err.message });
        } finally {
          if (conn) await conn.end().catch(() => {});
        }
      } else {
        return res.status(400).json({ error: `Adapter for ${effectiveType} is not yet implemented.` });
      }

      updateFields.encryptedUri = encrypt(updates.uri);
      updateFields.status = 'online';
      updateFields.lastCheck = new Date();
      updateFields.errorMessage = undefined;
    }

    const updated = await DatabaseService.findOneAndUpdate(
      { _id: id, ownerId },
      updateFields,
      { new: true, runValidators: true }
    ).select('-encryptedUri');

    res.json({ message: 'Database Updated', database: updated });
  } catch (error) {
    next(error);
  }
};

export const deleteDatabase = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const result = await DatabaseService.findOneAndDelete({ _id: id, ownerId });
    if (!result) return res.status(404).json({ error: 'Database not found' });

    await DbMetric.deleteMany({ dbId: id });
    await DbCollectionStat.deleteOne({ dbId: id });
    await DashboardShare.deleteMany({ scopeType: 'database', scopeId: id, ownerId });

    res.json({ message: 'Database and all metric history deleted' });
  } catch (error) {
    next(error);
  }
};