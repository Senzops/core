import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import admin from 'firebase-admin';

// Imports
import { authenticateUser, authenticateAgent, errorHandler } from './middlewares';
import { registerVps, listVps, deleteVps, ingestMetrics, getVpsStats } from './controllers';
import { logger } from './utils/logger';

if (!process.env.MONGO_URI) {
  dotenv.config({ path: ".env" });
}

// --- Configuration ---
const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI: string = process.env.MONGO_URI!;

// --- Firebase Init ---
// In production, use GOOGLE_APPLICATION_CREDENTIALS env var
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT!))
    });
    logger.info("Firebase Admin Initialized");
  } catch (e) {
    logger.error("Firebase Init Failed (Check env vars)", e);
  }
}

// --- Middlewares ---
app.use(helmet()); // Secure Headers
app.use(cors()); // CORS
app.use(express.json({ limit: '1mb' })); // Body parser
app.use(morgan('tiny')); // Logging

// --- Rate Limiters ---
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});

const ingestLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // Allow 1 request per second per IP (generous for agents)
});

// --- Routes ---

// 1. Management API (For Next.js Frontend)
const apiRouter = express.Router();
apiRouter.use(authenticateUser); // All routes below require Firebase Auth
apiRouter.post('/vps/register', apiLimiter, registerVps);
apiRouter.get('/vps/list', listVps);
apiRouter.delete('/vps/:id', deleteVps);
apiRouter.get('/vps/:id/stats', getVpsStats); // For Dashboard Graphs

// 2. Ingestion API (For Agents)
const ingestRouter = express.Router();
ingestRouter.use(ingestLimiter);
// We don't use User Auth here; we use Agent Auth
ingestRouter.post('/stats', authenticateAgent, ingestMetrics);

// Mount Routes
app.use('/api', apiRouter);
app.use('/api/ingest', ingestRouter);

// Health Check
app.get('/health', (req, res) => res.send('SysSentinel Core: Online'));

// Error Handling
app.use(errorHandler);

// --- Database & Start ---
mongoose.connect(MONGO_URI)
  .then(() => {
    logger.info('Connected to MongoDB');
    app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    logger.error('MongoDB Connection Error', err);
    process.exit(1);
  });