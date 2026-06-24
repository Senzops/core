import { Request, Response, NextFunction } from 'express';
import { WebApiKey } from '../models/Web';
import { hashApiKey } from '../utils/hashApiKey';

/**
 * Authenticates a request to the public Web Analytics query API (`/api/v1/web`).
 *
 * Accepts the key via `Authorization: Bearer <key>` or the `x-api-key` header.
 * Only the SHA-256 hash is ever compared against storage. On success the request
 * is scoped to exactly one website (webId + ownerId); `lastUsedAt` is bumped
 * best-effort without blocking the response.
 */
export const webApiKeyAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const header = req.headers['authorization'];
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const raw = (bearer || (req.headers['x-api-key'] as string) || '').trim();

    if (!raw) {
      return res.status(401).json({ error: 'Missing API key. Provide it as "Authorization: Bearer <key>" or "x-api-key".' });
    }

    const keyDoc = await WebApiKey.findOne({ keyHash: hashApiKey(raw), status: 'active' })
      .select('_id webId ownerId')
      .lean();

    if (!keyDoc) {
      return res.status(403).json({ error: 'Invalid or revoked API key.' });
    }

    (req as any).webApiContext = { webId: keyDoc.webId.toString(), ownerId: keyDoc.ownerId };

    // Best-effort usage timestamp; never blocks the request.
    WebApiKey.updateOne({ _id: keyDoc._id }, { $set: { lastUsedAt: new Date() } }).catch(() => { });

    next();
  } catch (error) {
    next(error);
  }
};
