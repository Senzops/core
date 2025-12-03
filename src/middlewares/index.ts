import { Request, Response, NextFunction } from 'express';
import admin from 'firebase-admin';
import { Vps } from '../models';
import { logger } from '../utils/logger';

// --- 1. User Auth (Firebase) ---
export const authenticateUser = async (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    (req as any).user = decodedToken; // Attach user to request
    next();
  } catch (error) {
    logger.info(error);
    return res.status(403).json({ error: 'Unauthorized: Invalid token' });
  }
};

// --- 2. Agent Auth (API Key) ---
export const authenticateAgent = async (req: Request, res: Response, next: NextFunction) => {
  const vpsId = req.headers['x-vps-id'] as string;
  const apiKey = req.headers['x-api-key'] as string;

  if (!vpsId || !apiKey) {
    return res.status(400).json({ error: 'Missing x-vps-id or x-api-key headers' });
  }

  try {
    // Check if VPS exists and key matches
    // Note: We use +apiKey to verify, in a real massive scale app we might use Redis here
    const vps = await Vps.findOne({ _id: vpsId }).select('+apiKey');

    if (!vps || vps.apiKey !== apiKey) {
      logger.warn(`Failed auth attempt for VPS: ${vpsId}`);
      return res.status(401).json({ error: 'Invalid Credentials' });
    }

    (req as any).vps = vps;
    next();
  } catch (error) {
    return res.status(500).json({ error: 'Internal Auth Error' });
  }
};

// --- 3. Global Error Handler ---
export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  logger.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
};