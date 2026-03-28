import { Request, Response, NextFunction, Router } from 'express';
import crypto from 'crypto';
import { McpApiKey, McpUsage } from '../../models/Mcp';

export const getMcpKeys = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const keys = await McpApiKey.find({ ownerId: uid }).select('-__v').sort({ createdAt: -1 }).lean();
    res.json({ keys });
  } catch (error) { next(error); }
};

export const createMcpKey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { name } = req.body;
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'A valid integration name is required' });

    const rawKey = `sz_mcp_${crypto.randomBytes(24).toString('hex')}`;
    const newKey = await McpApiKey.create({ ownerId: uid, name, key: rawKey, status: 'active' });

    res.status(201).json({ _id: newKey._id, name: newKey.name, key: rawKey, createdAt: newKey.createdAt });
  } catch (error) { next(error); }
};

export const revokeMcpKey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;
    const key = await McpApiKey.findOneAndUpdate({ _id: id, ownerId: uid }, { status: 'revoked' }, { new: true });
    if (!key) return res.status(404).json({ error: 'Key not found' });
    res.json({ success: true, message: 'Key successfully revoked' });
  } catch (error) { next(error); }
};

export const getMcpUsage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const range = req.query.range as string || '7d';

    const startDate = new Date();
    if (range === '24h') startDate.setHours(startDate.getHours() - 24);
    else if (range === '7d') startDate.setDate(startDate.getDate() - 7);
    else if (range === '30d') startDate.setDate(startDate.getDate() - 30);
    else startDate.setDate(startDate.getDate() - 7);

    let dateFormat = "%Y-%m-%dT%H:00:00.000Z";
    if (range === '7d' || range === '30d') dateFormat = "%Y-%m-%d";

    const trendRaw = await McpUsage.aggregate([
      { $match: { ownerId: uid, timestamp: { $gte: startDate } } },
      { $group: { _id: { $dateToString: { format: dateFormat, date: "$timestamp" } }, queries: { $sum: "$totalQueries" } } },
      { $sort: { "_id": 1 } }
    ]);

    const statsAgg = await McpUsage.aggregate([
      { $match: { ownerId: uid, timestamp: { $gte: startDate } } },
      { $group: { _id: null, totalQueries: { $sum: "$totalQueries" } } }
    ]);

    const usages = await McpUsage.find({ ownerId: uid, timestamp: { $gte: startDate } }).select('toolCalls').lean();
    const mergedToolCalls: Record<string, number> = {};
    usages.forEach(u => {
      if (u.toolCalls) {
        Object.entries(u.toolCalls).forEach(([tool, count]) => {
          mergedToolCalls[tool] = (mergedToolCalls[tool] || 0) + (count as number);
        });
      }
    });

    const trend = [];
    const now = new Date();
    let current = new Date(startDate);
    if (range === '24h') current.setMinutes(0, 0, 0);
    else current.setHours(0, 0, 0, 0);

    const dataMap = new Map(trendRaw.map((item: any) => [item._id, item]));

    while (current <= now) {
      let key = range === '24h' ? current.toISOString().slice(0, 13) + ":00:00.000Z" : current.toISOString().slice(0, 10);
      trend.push(dataMap.get(key) || { _id: key, queries: 0 });
      if (range === '24h') current.setHours(current.getHours() + 1);
      else current.setDate(current.getDate() + 1);
    }

    res.json({ totalQueries: statsAgg[0]?.totalQueries || 0, toolCalls: mergedToolCalls, trend });
  } catch (error) { next(error); }
};