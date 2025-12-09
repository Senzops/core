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
import { EnvUtils } from './utils/EnvUtils';
import { ingestWebMetrics } from './controllers/webIngest';
import { deleteWebsite, listWebsites, registerWebsite } from './controllers/web';
import { getWebStats } from './controllers/webStats';
import { deleteMonitor, getMonitorStats, listMonitors, registerMonitor } from './controllers/uptime';

if (!process.env.MONGO_URI) {
  dotenv.config({ path: "src/config/.env" });
}

// --- Configuration ---
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 5000;
const MONGO_URI: string = process.env.MONGO_URI!;

// --- Firebase Init ---
if (!admin.apps.length) {
  try {
    const serviceAccountString = EnvUtils.getEnvValue('FIREBASE_SERVICE_ACCOUNT');
    const serviceAccount = EnvUtils.parseAsObject(serviceAccountString!);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    logger.info("Firebase Admin Initialized");
  } catch (e) {
    logger.error("Firebase Init Failed (Check env vars)", e);
  }
}

// --- Middlewares ---
// Security Headers (Helmet)
// CRITICAL: We must allow Cross-Origin Resource Policy for the Web Agent to POST data
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS (Cross-Origin Resource Sharing)
// CRITICAL: Allow any origin (since the agent runs on user websites)
app.use(cors({
  origin: true, // Reflects the request origin (Allows all)
  credentials: true
}));
app.use(express.json({ limit: '1mb' })); // Body parser
app.use(morgan('tiny')); // Logging

// --- Rate Limiters ---
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});

const agentIngestLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // Allow 1 request per second per IP (generous for agents)
});

const webIngestLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 200,
});

// --- Routes Definition ---

// 1. Ingestion API (Agent) 
// Defined FIRST so it doesn't get caught by the generic /api middleware
const ingestRouter = express.Router();
ingestRouter.post('/stats', agentIngestLimiter, authenticateAgent, ingestMetrics);
ingestRouter.post('/web', webIngestLimiter, ingestWebMetrics);

// 2. Management API (Frontend User)
const apiRouter = express.Router();
apiRouter.use(authenticateUser);
apiRouter.post('/vps/register', apiLimiter, registerVps);
apiRouter.get('/vps/list', listVps);
apiRouter.delete('/vps/:id', deleteVps);
apiRouter.get('/vps/:id/stats', getVpsStats);

// 3. Web Analytics API
apiRouter.post('/web/register', registerWebsite);
apiRouter.get('/web/list', listWebsites);
apiRouter.delete('/web/:id', deleteWebsite);
apiRouter.get('/web/:id/stats', getWebStats);

// 4. Uptime Monitor
apiRouter.post('/uptime/register', registerMonitor);
apiRouter.get('/uptime/list', listMonitors);
apiRouter.delete('/uptime/:id', deleteMonitor);
apiRouter.get('/uptime/:id/stats', getMonitorStats);

// --- Mounting Routes (CRITICAL ORDER) ---

// Mount Ingest FIRST.
// Matches /api/ingest/stats strictly.
app.use('/api/ingest', ingestRouter);

// Mount Dashboard API SECOND.
// This catches everything else starting with /api (like /api/vps/...)
// and applies the authenticateUser middleware.
app.use('/api', apiRouter);

// Health Check (Public)
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