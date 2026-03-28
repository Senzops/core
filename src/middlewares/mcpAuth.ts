import { Request, Response, NextFunction } from 'express';
import { McpApiKey } from '../models/Mcp';
import { logger } from '../utils/logger';

export const authenticateMcp = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    let apiKey = req.headers['x-mcp-api-key'] as string;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      apiKey = authHeader.substring(7);
    }

    if (!apiKey) {
      return res.status(401).json({ error: 'Missing MCP API Key' });
    }

    const keyRecord = await McpApiKey.findOne({ key: apiKey, status: 'active' }).lean();

    if (!keyRecord) {
      return res.status(403).json({ error: 'Invalid or revoked MCP API Key' });
    }

    // Attach owner context
    (req as any).user = { uid: keyRecord.ownerId };

    // Fire & Forget: Update last used timestamp stat
    McpApiKey.findByIdAndUpdate(keyRecord._id, { lastUsedAt: new Date() }).catch(() => { });

    next();
  } catch (error) {
    logger.error('[MCP Auth Error]', error);
    res.status(500).json({ error: 'Internal server error during MCP authentication' });
  }
};