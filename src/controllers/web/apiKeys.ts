import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { Website, WebApiKey } from '../../models/Web';
import { hashApiKey } from '../../utils/hashApiKey';

const MAX_KEYS_PER_SITE = 10;

const resolveSite = async (req: Request) => {
  const ownerId = (req as any).ownerId;
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id.trim())) return { error: 'Invalid website id' as const };
  const site = await Website.findOne({ _id: id.trim(), ownerId }).select('_id ownerId').lean();
  if (!site) return { error: 'Website not found' as const };
  return { ownerId, webId: id.trim() };
};

// --- Create a key (plaintext returned exactly once) ---
export const createWebApiKey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resolved = await resolveSite(req);
    if ('error' in resolved) {
      return res.status(resolved.error === 'Website not found' ? 404 : 400).json({ error: resolved.error });
    }

    const name = (req.body?.name || '').toString().trim();
    if (!name || name.length > 60) {
      return res.status(400).json({ error: 'A name (1–60 chars) is required.' });
    }

    const activeCount = await WebApiKey.countDocuments({ ownerId: resolved.ownerId, webId: resolved.webId, status: 'active' });
    if (activeCount >= MAX_KEYS_PER_SITE) {
      return res.status(402).json({ error: `API key limit reached (${MAX_KEYS_PER_SITE} active keys per website).` });
    }

    const rawKey = `szw_${crypto.randomBytes(24).toString('hex')}`;
    const prefix = rawKey.slice(0, 12);

    await WebApiKey.create({
      ownerId: resolved.ownerId,
      webId: resolved.webId,
      name,
      keyHash: hashApiKey(rawKey),
      prefix,
      status: 'active',
    });

    // The plaintext key is returned ONCE and never again.
    res.status(201).json({ message: 'API key created', key: rawKey, prefix, name });
  } catch (error) {
    next(error);
  }
};

// --- List keys (never returns the hash or plaintext) ---
export const listWebApiKeys = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resolved = await resolveSite(req);
    if ('error' in resolved) {
      return res.status(resolved.error === 'Website not found' ? 404 : 400).json({ error: resolved.error });
    }

    const keys = await WebApiKey.find({ ownerId: resolved.ownerId, webId: resolved.webId })
      .select('name prefix status lastUsedAt createdAt')
      .sort({ createdAt: -1 })
      .lean();

    res.json(keys);
  } catch (error) {
    next(error);
  }
};

// --- Revoke a key ---
export const revokeWebApiKey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resolved = await resolveSite(req);
    if ('error' in resolved) {
      return res.status(resolved.error === 'Website not found' ? 404 : 400).json({ error: resolved.error });
    }

    const { keyId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(keyId)) return res.status(400).json({ error: 'Invalid key id' });

    const deleted = await WebApiKey.findOneAndDelete({ _id: keyId, ownerId: resolved.ownerId, webId: resolved.webId });
    if (!deleted) return res.status(404).json({ error: 'API key not found' });

    res.json({ message: 'API key revoked' });
  } catch (error) {
    next(error);
  }
};
