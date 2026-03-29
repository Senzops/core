import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import admin from 'firebase-admin';
import senzor from '@senzops/apm-node';

// Imports
import { authenticateUser, authenticateAgent, errorHandler } from '../middlewares';
import { registerVps, listVps, deleteVps, ingestMetrics, getVpsStats } from '../controllers/vps';
import { logger } from '../utils/logger';
import { EnvUtils } from '../utils/envUtils';
import { ingestWebMetrics } from '../controllers/web/webIngest';
import { deleteWebsite, listWebsites, registerWebsite } from '../controllers/web/main';
import { getWebStats } from '../controllers/web/webStats';
import { deleteMonitor, getMonitorStats, listMonitors, registerMonitor } from '../controllers/monitor';
import { getRandomStatus } from '../controllers/demo';
import { createServer } from 'http';
import { initSocketServer } from '../services/socket';
import { ingestApmBatch } from '../controllers/apm/ingest';
import { deleteService, listServices, registerService } from '../controllers/apm/main';
import { getApmStats } from '../controllers/apm/stats';
import { getInvocations, getTraceDetail } from '../controllers/apm/traces';
import { registerDatabase, listDatabases, deleteDatabase } from '../controllers/database/main';
import { getDatabaseStats } from '../controllers/database/stats';
import { ingestTaskBatch } from '../controllers/task/ingest';
import { deleteTaskService, listTaskServices, registerTaskService } from '../controllers/task/main';
import { getTaskEntityDetail, getTaskRunDetail, getTaskServiceDashboard } from '../controllers/task/stats';
import { getErrorGroupDetails, getGlobalErrors, getTraceErrors, updateErrorStatus } from '../controllers/error';
import { ingestRumBatch } from '../controllers/rum/ingest';
import {
  registerService as registerRumService,
  listServices as listRumServices,
  deleteService as deleteRumService
} from '../controllers/rum/main';
import { getRumDashboard, getRumTraceDetail } from '../controllers/rum/stats';
import { ingestGlobalLogs, getDashboardLogs, getTraceLogs, getLogApiKey, getLogById } from '../controllers/logs';
import { authenticateMcp } from '../middlewares/mcpAuth';
import {
  getMcpKeys,
  createMcpKey,
  revokeMcpKey,
  getMcpUsage
} from '../controllers/mcp/main';
import { mcpAgentRouter } from '../controllers/mcp/agent';
import { initGeoDb } from '../utils/GeoDbManager';


if (!process.env.MONGO_URI) {
  dotenv.config({ path: "src/config/.env" });
}

// --- Configuration ---
const app = express();
const httpServer = createServer(app);
app.set('trust proxy', 1);
const PORT = process.env.PORT || 5000;
const MONGO_URI: string = process.env.MONGO_URI!;
const SENZOR_APM_API_KEY: string = process.env.SENZOR_APM_API_KEY!;

senzor.init({
  apiKey: SENZOR_APM_API_KEY
});

// Pre-warm the geo database reader at startup
initGeoDb();

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
app.use(senzor.requestHandler());  // senzor apm
// Security Headers (Helmet)
// CRITICAL: We must allow Cross-Origin Resource Policy for the Web Agent to POST data
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS (Cross-Origin Resource Sharing)
// CRITICAL: Allow any origin (since the agent runs on user websites)
app.use(cors({
  origin: true, // Reflects the request origin (Allows all)
  credentials: true,
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

const apmLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
});

// AI AGENT ROUTES
// Explicitly isolated and mounted FIRST to bypass standard user JWT logic.
app.use('/api/mcp', mcpAgentRouter);

// --- Routes Definition ---

// 1. Ingestion API
// Defined FIRST so it doesn't get caught by the generic /api middleware
const ingestRouter = express.Router();
ingestRouter.post('/stats', agentIngestLimiter, authenticateAgent, ingestMetrics);
ingestRouter.post('/web', webIngestLimiter, ingestWebMetrics);
ingestRouter.post('/apm', apmLimiter, ingestApmBatch);
ingestRouter.post('/task', apmLimiter, ingestTaskBatch);
ingestRouter.post('/rum', apmLimiter, ingestRumBatch);
ingestRouter.post('/logs', apmLimiter, ingestGlobalLogs);

// 2. VPS API (Frontend User)
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

// 4. Uptime Monitor API
apiRouter.post('/uptime/register', registerMonitor);
apiRouter.get('/uptime/list', listMonitors);
apiRouter.delete('/uptime/:id', deleteMonitor);
apiRouter.get('/uptime/:id/stats', getMonitorStats);

// --- APM (Dashboard) ---
apiRouter.post('/apm/register', registerService);
apiRouter.get('/apm/list', listServices);
apiRouter.delete('/apm/:id', deleteService);
apiRouter.get('/apm/:id/stats', getApmStats);
apiRouter.get('/apm/:id/invocations', getInvocations);
apiRouter.get('/apm/:id/trace/:traceId', getTraceDetail);

// --- Database (Dashboard) ---
apiRouter.post('/database/register', registerDatabase);
apiRouter.get('/database/list', listDatabases);
apiRouter.delete('/database/:id', deleteDatabase);
apiRouter.get('/database/:id/stats', getDatabaseStats);

// --- GLOBAL ERROR TRACKING ---
apiRouter.get('/errors', getGlobalErrors); // Global paginated list
apiRouter.get('/errors/:groupId', getErrorGroupDetails); // Single error group + trend
apiRouter.patch('/errors/:groupId/status', updateErrorStatus); // Resolve/Ignore

// --- TRACE SPECIFIC ERRORS (Added to APM routes) ---
// Gets all raw error events that occurred during a specific HTTP trace
apiRouter.get('/apm/:id/trace/:traceId/errors', getTraceErrors);

// Task Services Management
apiRouter.post('/task/register', registerTaskService);
apiRouter.get('/task/list', listTaskServices);
apiRouter.delete('/task/:id', deleteTaskService);

// Task Dashboards & Analytics
apiRouter.get('/task/:id/dashboard', getTaskServiceDashboard);
apiRouter.get('/task/:id/entity/:taskName', getTaskEntityDetail);
apiRouter.get('/task/:id/run/:runId', getTaskRunDetail);

// --- RUM / WEB APM (Dashboard) ---
apiRouter.post('/rum/register', registerRumService);
apiRouter.get('/rum/list', listRumServices);
apiRouter.delete('/rum/:id', deleteRumService);
apiRouter.get('/rum/:id/dashboard', getRumDashboard);
apiRouter.get('/rum/:id/trace/:traceId', getRumTraceDetail);


// --- NEW LOG MANAGEMENT ROUTES ---
apiRouter.get('/logs', getDashboardLogs);
apiRouter.get('/logs/key', getLogApiKey);
apiRouter.get('/logs/:id', getLogById);

// Bi-directional Trace to Log links
apiRouter.get('/apm/:id/trace/:traceId/logs', getTraceLogs);
apiRouter.get('/rum/:id/trace/:traceId/logs', getTraceLogs);
apiRouter.get('/task/:id/run/:traceId/logs', getTraceLogs); // We use traceId path param to map to runId


// --- MCP routes ---

apiRouter.get('/mcp/keys', getMcpKeys);
apiRouter.post('/mcp/keys', createMcpKey);
apiRouter.delete('/mcp/keys/:id', revokeMcpKey);
apiRouter.get('/mcp/usage', getMcpUsage);


// --- Mounting Routes (CRITICAL ORDER) ---

// Mount Ingest FIRST.
// Matches /api/ingest/* strictly.
app.use('/api/ingest', ingestRouter);

// Mount Dashboard API SECOND.
// This catches everything else starting with /api (like /api/vps/...)
// and applies the authenticateUser middleware.
app.use('/api', apiRouter);

// Health Check (Public)
app.get('/health', (req, res) => res.send('Senzor Core: Online'));
app.get('/status', getRandomStatus);

app.use(senzor.errorHandler());
// Error Handling
app.use(errorHandler);

// Initialize Socket.io
initSocketServer(httpServer);


// --- Database & Start ---
mongoose.connect(MONGO_URI)
  .then(() => {
    logger.info('Connected to MongoDB');
    httpServer.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    logger.error('MongoDB Connection Error', err);
    process.exit(1);
  });