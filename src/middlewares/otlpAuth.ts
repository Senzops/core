import { Request, Response, NextFunction } from 'express';
import { ApmService } from '../models/Apm';
import { RumService } from '../models/Rum';
import { TaskService } from '../models/Task';
import { logger } from '../utils/logger';

export interface OtlpContext {
  ownerId: string;
  serviceId: string;
  target: 'apm' | 'rum' | 'task';
  serviceName: string;
}

// Extend Express Request to include our strict OTLP Context
declare global {
  namespace Express {
    interface Request {
      otlpContext?: OtlpContext;
    }
  }
}

export const authenticateOtlp = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: "Missing or invalid Authorization header. Expected 'Bearer <API_KEY>'" });
    }

    const apiKey = authHeader.split(' ')[1];

    // Execute parallel lookups across all supported OTel target registries to minimize ingestion latency
    const [apmMatch, rumMatch, taskMatch] = await Promise.all([
      ApmService.findOne({ apiKey }).select('_id ownerId name').lean(),
      RumService.findOne({ apiKey }).select('_id ownerId name').lean(),
      TaskService.findOne({ apiKey }).select('_id ownerId name').lean()
    ]);

    let context: OtlpContext | null = null;

    if (apmMatch) {
      context = { ownerId: apmMatch.ownerId, serviceId: apmMatch._id.toString(), target: 'apm', serviceName: apmMatch.name };
    } else if (rumMatch) {
      context = { ownerId: rumMatch.ownerId, serviceId: rumMatch._id.toString(), target: 'rum', serviceName: rumMatch.name };
    } else if (taskMatch) {
      context = { ownerId: taskMatch.ownerId, serviceId: taskMatch._id.toString(), target: 'task', serviceName: taskMatch.name };
    }

    if (!context) {
      logger.warn(`[OTLP Auth] Rejected telemetry payload. Invalid or revoked API Key: ${apiKey.substring(0, 8)}...`);
      return res.status(403).json({ error: "Unauthorized. Invalid API Key or service is offline." });
    }

    // Attach the verified, tenant-isolated context to the request
    req.otlpContext = context;
    next();
  } catch (error: any) {
    logger.error(`[OTLP Auth] Authentication failure: ${error.message}`);
    res.status(500).json({ error: "Internal server error during OTLP authentication" });
  }
};