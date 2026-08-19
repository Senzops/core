import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import admin from 'firebase-admin';

// Imports
import { authenticateUser, authenticateAgent, errorHandler } from '../middlewares';
import { registerVps, listVps, deleteVps, updateVps, ingestMetrics, getVpsStats } from '../controllers/vps';
import { logger } from '../utils/logger';
import { EnvUtils } from '../utils/envUtils';
import { ingestWebMetrics } from '../controllers/web/webIngest';
import { deleteWebsite, listWebsites, registerWebsite, updateWebsite } from '../controllers/web/main';
import { getWebStats } from '../controllers/web/webStats';
import { getWebEvents } from '../controllers/web/webEvents';
import { createFunnel, listFunnels, updateFunnel, deleteFunnel, analyzeFunnel } from '../controllers/web/funnels';
import { getWebRealtime } from '../controllers/web/webRealtime';
import { listAnnotations, createAnnotation, updateAnnotation, deleteAnnotation } from '../controllers/web/annotations';
import { getWebRetention, getWebPaths } from '../controllers/web/insights';
import { createWebApiKey, listWebApiKeys, revokeWebApiKey } from '../controllers/web/apiKeys';
import { apiOverview, apiTimeseries, apiBreakdown, apiEvents } from '../controllers/web/queryApi';
import { webApiKeyAuth } from '../middlewares/webApiAuth';
import { deleteMonitor, getMonitorStats, listMonitors, registerMonitor, updateMonitor } from '../controllers/monitor';
import { listBoards, createBoard, getBoardById, updateBoard, deleteBoard, getBoardSummary } from '../controllers/monitorBoard';
import { getRandomStatus } from '../controllers/demo';
import { createServer } from 'http';
import { initSocketServer } from '../services/socket';
import { ingestApmBatch } from '../controllers/apm/ingest';
import { deleteService, listServices, registerService, updateService } from '../controllers/apm/main';
import { getApmStats } from '../controllers/apm/stats';
import { getRuntimeStats } from '../controllers/apm/runtimeStats';
import { getInvocations, getTraceDetail } from '../controllers/apm/traces';
import { registerDatabase, listDatabases, deleteDatabase, updateDatabase } from '../controllers/database/main';
import { getDatabaseStats } from '../controllers/database/stats';
import { registerQueueSource, listQueueSources, updateQueueSource, deleteQueueSource } from '../controllers/queue/main';
import { getQueueStats, getQueueEntityDetail } from '../controllers/queue/stats';
import { getQueueExecutions, getDiscoveredQueues } from '../controllers/queue/correlation';
import { registerFirebase, listFirebaseServices, updateFirebase, deleteFirebase } from '../controllers/firebase/main';
import { getFirebaseStats } from '../controllers/firebase/stats';
import { ingestTaskBatch } from '../controllers/task/ingest';
import { ingestQueueBatch } from '../controllers/queue/ingest';
import { ingestAiBatch } from '../controllers/ai/observability/ingest';
import {
  registerAiSource,
  listAiSources,
  getAiSource,
  updateAiSource,
  deleteAiSource,
  getAiStats,
  getAiTraces,
  getAiGenerations,
  getAiTraceDetail,
  getAiConsumers,
  getAiReliability,
  submitAiScore,
} from '../controllers/ai/observability';
import { deleteTaskService, listTaskServices, registerTaskService, updateTaskService } from '../controllers/task/main';
import { getTaskEntityDetail, getTaskRunDetail, getTaskServiceDashboard } from '../controllers/task/stats';
import { getErrorGroupDetails, getGlobalErrors, getTraceErrors, updateErrorStatus } from '../controllers/error';
import { ingestRumBatch } from '../controllers/rum/ingest';
import {
  registerService as registerRumService,
  listServices as listRumServices,
  deleteService as deleteRumService,
  updateRumService
} from '../controllers/rum/main';
import { getRumDashboard, getRumTraceDetail } from '../controllers/rum/stats';
import { getRumSessions, getRumSessionDetail } from '../controllers/rum/sessions';
import { uploadSourceMap, listSourceMaps, deleteSourceMap, symbolicateRumStack } from '../controllers/rum/sourcemaps';
import { ingestGlobalLogs, getDashboardLogs, getTraceLogs, getLogApiKey, getLogById, listLogKeys, createLogKey, revokeLogKey, getLogFacets, getLogContext, exportLogs, getIngestStats } from '../controllers/logs';
import { ndjsonBody } from '../middlewares/ndjsonBody';
import {
  getMcpKeys,
  createMcpKey,
  revokeMcpKey,
  getMcpUsage
} from '../controllers/mcp/main';
import { mcpAgentRouter } from '../controllers/mcp/agent';
import {
  createDestination,
  listDestinations,
  updateDestination,
  deleteDestination,
  createPolicy,
  listPolicies,
  getPolicyDetails,
  updatePolicy,
  deletePolicy,
  createCondition,
  updateCondition,
  deleteCondition,
  muteCondition,
  unmuteCondition,
  testCondition,
  listIncidents,
  getIncidentDetail,
  updateIncidentStatus,
  updateIncidentSeverity,
  assignIncident,
  addIncidentNote,
  bulkUpdateIncidents,
  createSilence,
  listSilences,
  deleteSilence,
  getIncidentAnalysis,
  triggerIncidentAnalysis,
} from '../controllers/alerts';
import { requirePlan } from '../middlewares/planGate';
import {
  createView,
  listViews,
  getViewById,
  updateViewLayout,
  deleteView,
  createWidget,
  updateWidget,
  deleteWidget
} from '../controllers/view/main';
import { executeLivePreview, getWidgetData } from '../controllers/view/engine';
import {
  createShare,
  listShares,
  updateShare,
  revokeShare,
  getSharedMeta,
  getSharedView,
  getSharedWidgetData,
} from '../controllers/view/share';
import { resolveShareContext, enforceShareScope, applyShareTimeRange, cachePublicShare } from '../middlewares/shareAuth';
import { authenticateOtlp } from '../middlewares/otlpAuth';
import { ingestOtlpLogs, ingestOtlpTraces } from '../controllers/otlp/gateway';
import { requireIngestionQuota } from '../middlewares/ingestionLimiter';
import { requireServiceQuota, requireOrgCreationQuota } from '../middlewares/serviceLimiter';
import { cancelSubscription, changePlan, getActivePlans, getCurrentSubscription, getStorageStats, getTransactionReceipt, getTransactions, handlePaddleWebhook, handleDodoWebhook, createCheckoutSession } from '../controllers/billing';
import { deleteAccount, syncUser } from '../controllers/user';
import { sendOtp, verifyOtp, revokeSessions, getOtpStatus, getAuthSession } from '../controllers/auth/otp';
import { requireOtpVerified } from '../middlewares/otpGate';
import { getDynamicSchema } from '../controllers/schema';
import { getDashboardCapabilities } from '../controllers/dashboard/capabilities';
import { shutdownQueues } from '../lib/queue';
import { shutdownCache } from '../lib/cache';
import { resolveWorkspace } from '../middlewares/orgAuth';
import {
  createOrganization,
  listOrganizations,
  getOrganization,
  updateOrganization,
  deleteOrganization,
  listMembers,
  updateMember,
  removeMember,
  sendInvitation,
  listInvitations,
  revokeInvitation,
  acceptInvitation,
  getInvitationDetails,
  transferOwnership,
} from '../controllers/organization/main';
import { exportConfig } from '../controllers/data/exportConfig';
import {
  createConversation,
  listConversations,
  getConversation,
  updateConversation,
  deleteConversation,
  appendMessages,
} from '../controllers/ai/conversations';
import { previewConfigImport, importConfig } from '../controllers/data/importConfig';
import { exportTelemetry } from '../controllers/data/exportTelemetry';
import { importTelemetry } from '../controllers/data/importTelemetry';


if (!process.env.MONGO_URI) {
  dotenv.config({ path: "src/config/.env" });
}

// --- Configuration ---
const app = express();
const httpServer = createServer(app);
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

    admin.auth().projectConfigManager().updateProjectConfig({
      multiFactorConfig: {
        state: 'ENABLED',
        providerConfigs: [{
          state: 'ENABLED',
          totpProviderConfig: { adjacentIntervals: 5 },
        }],
      },
    }).catch((err: any) => {
      logger.warn(`[Firebase] TOTP MFA config skipped: ${err.message}`);
    });
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
  credentials: true,
}));

// HTTP Response Compression (gzip / deflate)
// Placed after CORS, before body parser — compresses all outgoing responses.
// Reduces JSON payload sizes by 70-85%, zero client-side changes needed.
app.use(compression({
  level: 6,           // Balanced compression (1=fast/low, 9=slow/max). 6 is zlib default.
  threshold: 1024,    // Skip compression for responses < 1KB (overhead > savings)
  filter: (req, res) => {
    // Never compress SSE streams — compression buffers chunks, breaking real-time delivery
    const contentType = res.getHeader('Content-Type');
    if (typeof contentType === 'string' && contentType.includes('text/event-stream')) {
      return false;
    }
    // Default filter: compress JSON, HTML, text, SVG, etc. Skip images/binary.
    return compression.filter(req, res);
  },
}));

// Body parser — skip for routes that mount their own higher-limit parser:
//  - telemetry import (50mb)
//  - APM/Task ingest (5mb): native-agent batches carry span-heavy payloads that
//    routinely exceed 1mb; these paths attach their own parser below.
//  - OTLP (10mb, prefix /api/otlp/*): the OTLP router mounts its own parser, but
//    this global parser runs first and would cap bodies at 1mb otherwise. None
//    of the OTLP routes depend on req.rawBody, so bypassing here is safe.
const HIGHER_LIMIT_BODY_PATHS = new Set([
  '/api/data/import/telemetry',
  '/api/ingest/apm',
  '/api/ingest/task',
  '/api/ingest/ai',
  '/api/ingest/rum/sourcemap',
]);
app.use((req, res, next) => {
  if (HIGHER_LIMIT_BODY_PATHS.has(req.path) || req.path.startsWith('/api/otlp/')) {
    return next();
  }
  express.json({
    limit: '1mb',
    verify: (req: any, res, buf) => {
      req.rawBody = buf;
    }
  })(req, res, next);
});
app.use(morgan('tiny')); // Logging

// --- Rate Limiters ---
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Credential endpoints get their own budgets, keyed per account where a user
// context exists so a shared egress IP cannot starve other tenants. The
// account-level caps in controllers/auth/otp.ts remain the real ceiling;
// these are the cheap outer wall in front of them.
const authRateKey = (req: any): string => {
  // authenticateUser runs before these limiters, so uid is the normal key.
  if (req.user?.uid) return `uid:${req.user.uid}`;
  // Defensive fallback only. IPv6 clients are routinely handed an entire /64,
  // so keying on the full address would let a single host rotate past the cap.
  const ip: string = req.ip || 'unknown';
  return ip.includes(':') ? `ip6:${ip.split(':').slice(0, 4).join(':')}` : `ip:${ip}`;
};

const otpSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: authRateKey,
});

const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: authRateKey,
});

const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 300,
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

// Public Web Analytics query API — key-authenticated, read-only programmatic access.
const webApiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
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
// Span-heavy native-agent batches (APM traces / Task runs) need headroom above
// the global 1mb limit; these paths are excluded from the global parser above.
const agentBatchBody = express.json({ limit: '5mb' });
ingestRouter.post('/stats', agentIngestLimiter, authenticateAgent, requireIngestionQuota, ingestMetrics);
ingestRouter.post('/web', webIngestLimiter, requireIngestionQuota, ingestWebMetrics);
ingestRouter.post('/apm', agentBatchBody, apmLimiter, requireIngestionQuota, ingestApmBatch);
ingestRouter.post('/task', agentBatchBody, apmLimiter, requireIngestionQuota, ingestTaskBatch);
ingestRouter.post('/ai', agentBatchBody, apmLimiter, requireIngestionQuota, ingestAiBatch);
ingestRouter.post('/queue', agentBatchBody, apmLimiter, requireIngestionQuota, ingestQueueBatch);
ingestRouter.post('/rum', apmLimiter, requireIngestionQuota, ingestRumBatch);
// Source map upload — its own 20mb body parser (excluded from the global 1mb parser).
ingestRouter.post('/rum/sourcemap', express.json({ limit: '20mb' }), apmLimiter, uploadSourceMap);
ingestRouter.post('/logs', apmLimiter, ...ndjsonBody, requireIngestionQuota, ingestGlobalLogs);

// 2. VPS API (Frontend User)
const apiRouter = express.Router();
apiRouter.use(authenticateUser);
// Second factor is enforced here, before workspace resolution, so an unverified
// caller cannot even enumerate organization membership. /user/sync is the sole
// exemption: the JIT identity upsert has to land before verification, otherwise
// a brand-new user has no document (and no subscription) to verify against.
apiRouter.use(requireOtpVerified({ exempt: ['/user/sync'] }));
apiRouter.use(resolveWorkspace);
apiRouter.post('/vps/register', apiLimiter, requireServiceQuota('Vps', 'Server'), registerVps);
apiRouter.get('/vps/list', listVps);
apiRouter.put('/vps/:id', updateVps);
apiRouter.delete('/vps/:id', deleteVps);
apiRouter.get('/vps/:id/stats', getVpsStats);

// 3. Web Analytics API
apiRouter.post('/web/register', requireServiceQuota('Website', 'Web Analytics'), registerWebsite);
apiRouter.get('/web/list', listWebsites);
apiRouter.put('/web/:id', updateWebsite);
apiRouter.delete('/web/:id', deleteWebsite);
apiRouter.get('/web/:id/stats', getWebStats);
apiRouter.get('/web/:id/events', getWebEvents);
apiRouter.get('/web/:id/realtime', getWebRealtime);
apiRouter.get('/web/:id/retention', getWebRetention);
apiRouter.get('/web/:id/paths', getWebPaths);
apiRouter.post('/web/:id/keys', createWebApiKey);
apiRouter.get('/web/:id/keys', listWebApiKeys);
apiRouter.delete('/web/:id/keys/:keyId', revokeWebApiKey);
apiRouter.post('/web/:id/funnels', createFunnel);
apiRouter.get('/web/:id/funnels', listFunnels);
apiRouter.put('/web/:id/funnels/:funnelId', updateFunnel);
apiRouter.delete('/web/:id/funnels/:funnelId', deleteFunnel);
apiRouter.get('/web/:id/funnels/:funnelId/analyze', analyzeFunnel);
apiRouter.get('/web/:id/annotations', listAnnotations);
apiRouter.post('/web/:id/annotations', createAnnotation);
apiRouter.put('/web/:id/annotations/:annotationId', updateAnnotation);
apiRouter.delete('/web/:id/annotations/:annotationId', deleteAnnotation);

// 4. Uptime Monitor API
apiRouter.post('/uptime/register', requireServiceQuota('Monitor', 'Uptime Monitor'), registerMonitor);
apiRouter.get('/uptime/list', listMonitors);
apiRouter.put('/uptime/:id', updateMonitor);
apiRouter.delete('/uptime/:id', deleteMonitor);
apiRouter.get('/uptime/:id/stats', getMonitorStats);

// --- Status Boards (centralized, shareable uptime dashboards) ---
apiRouter.get('/monitor-board', listBoards);
apiRouter.post('/monitor-board', createBoard);
apiRouter.get('/monitor-board/:id', getBoardById);
apiRouter.put('/monitor-board/:id', updateBoard);
apiRouter.delete('/monitor-board/:id', deleteBoard);
apiRouter.get('/monitor-board/:id/summary', getBoardSummary);

// --- APM (Dashboard) ---
apiRouter.post('/apm/register', requireServiceQuota('ApmService', 'APM Component'), registerService);
apiRouter.get('/apm/list', listServices);
apiRouter.put('/apm/:id', updateService);
apiRouter.delete('/apm/:id', deleteService);
apiRouter.get('/apm/:id/stats', getApmStats);
apiRouter.get('/apm/:id/runtime', getRuntimeStats);
apiRouter.get('/apm/:id/invocations', getInvocations);
apiRouter.get('/apm/:id/trace/:traceId', getTraceDetail);

// --- Database (Dashboard) ---
apiRouter.post('/database/register', requireServiceQuota('DatabaseService', 'Database'), registerDatabase);
apiRouter.get('/database/list', listDatabases);
apiRouter.put('/database/:id', updateDatabase);
apiRouter.delete('/database/:id', deleteDatabase);
apiRouter.get('/database/:id/stats', getDatabaseStats);

// --- Queue Monitoring (BullMQ/Redis, agentless pull-plane) ---
apiRouter.post('/queue/register', requireServiceQuota('QueueSource', 'Queue'), registerQueueSource);
apiRouter.get('/queue/list', listQueueSources);
apiRouter.get('/queue/discovered', getDiscoveredQueues);
apiRouter.put('/queue/:id', updateQueueSource);
apiRouter.delete('/queue/:id', deleteQueueSource);
apiRouter.get('/queue/:id/stats', getQueueStats);
apiRouter.get('/queue/:id/entity/:queueName', getQueueEntityDetail);
apiRouter.get('/queue/:id/executions', getQueueExecutions);

// --- AI Monitoring (LLM Observability) ---
// Namespaced under /ai/observability/* so it never collides with the in-app
// AI assistant routes mounted at /ai/conversations.
apiRouter.post('/ai/observability/register', requireServiceQuota('AiSource', 'AI Monitoring'), registerAiSource);
apiRouter.get('/ai/observability/list', listAiSources);
apiRouter.get('/ai/observability/:id', getAiSource);
apiRouter.put('/ai/observability/:id', updateAiSource);
apiRouter.delete('/ai/observability/:id', deleteAiSource);
apiRouter.get('/ai/observability/:id/stats', getAiStats);
apiRouter.get('/ai/observability/:id/consumers', getAiConsumers);
apiRouter.get('/ai/observability/:id/reliability', getAiReliability);
apiRouter.get('/ai/observability/:id/traces', getAiTraces);
apiRouter.get('/ai/observability/:id/generations', getAiGenerations);
apiRouter.get('/ai/observability/:id/trace/:traceId', getAiTraceDetail);
apiRouter.post('/ai/observability/:id/score', apmLimiter, submitAiScore);

// --- Firebase Monitoring ---
apiRouter.post('/firebase/register', requireServiceQuota('FirebaseService', 'Firebase Project'), registerFirebase);
apiRouter.get('/firebase/list', listFirebaseServices);
apiRouter.put('/firebase/:id', updateFirebase);
apiRouter.delete('/firebase/:id', deleteFirebase);
apiRouter.get('/firebase/:id/stats', getFirebaseStats);

// --- GLOBAL ERROR TRACKING ---
apiRouter.get('/errors', getGlobalErrors); // Global paginated list
apiRouter.get('/errors/:groupId', getErrorGroupDetails); // Single error group + trend
apiRouter.patch('/errors/:groupId/status', updateErrorStatus); // Resolve/Ignore

// --- TRACE SPECIFIC ERRORS (Added to APM routes) ---
// Gets all raw error events that occurred during a specific HTTP trace
apiRouter.get('/apm/:id/trace/:traceId/errors', getTraceErrors);

// Task Services Management
apiRouter.post('/task/register', requireServiceQuota('TaskService', 'Background Task'), registerTaskService);
apiRouter.get('/task/list', listTaskServices);
apiRouter.put('/task/:id', updateTaskService);
apiRouter.delete('/task/:id', deleteTaskService);

// Task Dashboards & Analytics
apiRouter.get('/task/:id/dashboard', getTaskServiceDashboard);
apiRouter.get('/task/:id/entity/:taskName', getTaskEntityDetail);
apiRouter.get('/task/:id/run/:runId', getTaskRunDetail);

// --- RUM / WEB APM (Dashboard) ---
apiRouter.post('/rum/register', requireServiceQuota('RumService', 'RUM Application'), registerRumService);
apiRouter.get('/rum/list', listRumServices);
apiRouter.put('/rum/:id', updateRumService);
apiRouter.delete('/rum/:id', deleteRumService);
apiRouter.get('/rum/:id/dashboard', getRumDashboard);
apiRouter.get('/rum/:id/sessions', getRumSessions);
apiRouter.get('/rum/:id/sessions/:sessionId', getRumSessionDetail);
apiRouter.get('/rum/:id/sourcemaps', listSourceMaps);
apiRouter.delete('/rum/:id/sourcemaps/:mapId', deleteSourceMap);
apiRouter.post('/rum/:id/symbolicate', symbolicateRumStack);
apiRouter.get('/rum/:id/trace/:traceId', getRumTraceDetail);


// --- NEW LOG MANAGEMENT ROUTES ---
apiRouter.get('/logs', getDashboardLogs);
apiRouter.get('/logs/facets', getLogFacets);     // field facets for the sidebar
apiRouter.get('/logs/export', exportLogs);        // stream NDJSON/CSV of a query
apiRouter.get('/logs/ingest-stats', getIngestStats); // ingestion health
apiRouter.get('/logs/key', getLogApiKey);         // legacy single-key (pre-Phase-4 modal)
// Multi-key management (defined before /logs/:id so they aren't captured by it)
apiRouter.get('/logs/keys', listLogKeys);
apiRouter.post('/logs/keys', createLogKey);
apiRouter.delete('/logs/keys/:id', revokeLogKey);
apiRouter.get('/logs/:id/context', getLogContext); // surrounding logs
apiRouter.get('/logs/:id', getLogById);

// Bi-directional Trace to Log links
apiRouter.get('/apm/:id/trace/:traceId/logs', getTraceLogs);
apiRouter.get('/rum/:id/trace/:traceId/logs', getTraceLogs);
apiRouter.get('/task/:id/run/:traceId/logs', getTraceLogs); // We use traceId path param to map to runId

// --- MCP routes ---
apiRouter.get('/mcp/keys', getMcpKeys);
apiRouter.post('/mcp/keys', requireServiceQuota('McpApiKey', 'MCP API Key'), createMcpKey);
apiRouter.delete('/mcp/keys/:id', revokeMcpKey);
apiRouter.get('/mcp/usage', getMcpUsage);

// --- ALERTS & INCIDENTS ---
apiRouter.post('/alerts/destinations', requireServiceQuota('AlertDestination', 'Alert Destination'), createDestination);
apiRouter.get('/alerts/destinations', listDestinations);
apiRouter.put('/alerts/destinations/:id', updateDestination);
apiRouter.delete('/alerts/destinations/:id', deleteDestination);
apiRouter.post('/alerts/policies', requireServiceQuota('AlertPolicy', 'Alert Policy'), createPolicy);
apiRouter.get('/alerts/policies', listPolicies);
apiRouter.get('/alerts/policies/:id', getPolicyDetails);
apiRouter.put('/alerts/policies/:id', updatePolicy);
apiRouter.delete('/alerts/policies/:id', deletePolicy);
apiRouter.post('/alerts/conditions', requireServiceQuota('AlertCondition', 'Alert Condition'), createCondition);
apiRouter.put('/alerts/conditions/:id', updateCondition);
apiRouter.delete('/alerts/conditions/:id', deleteCondition);
apiRouter.post('/alerts/conditions/:id/mute', muteCondition);
apiRouter.post('/alerts/conditions/:id/unmute', unmuteCondition);
apiRouter.post('/alerts/conditions/test', testCondition);
apiRouter.get('/alerts/incidents', listIncidents);
apiRouter.get('/alerts/incidents/:id', getIncidentDetail);
apiRouter.patch('/alerts/incidents/:id/status', updateIncidentStatus);
apiRouter.patch('/alerts/incidents/:id/severity', updateIncidentSeverity);
apiRouter.patch('/alerts/incidents/:id/assign', assignIncident);
apiRouter.post('/alerts/incidents/:id/notes', addIncidentNote);
apiRouter.post('/alerts/incidents/bulk', bulkUpdateIncidents);
apiRouter.get('/alerts/incidents/:id/analysis', getIncidentAnalysis);
apiRouter.post('/alerts/incidents/:id/analysis', requirePlan('business'), triggerIncidentAnalysis);
apiRouter.post('/alerts/silences', createSilence);
apiRouter.get('/alerts/silences', listSilences);
apiRouter.delete('/alerts/silences/:id', deleteSilence);

// --- SAVED VIEWS (CUSTOM DASHBOARDS) ---
apiRouter.post('/views', requireServiceQuota('SavedView', 'Dashboard View'), createView);
apiRouter.get('/views', listViews);
apiRouter.get('/views/:id', getViewById);
apiRouter.put('/views/:id', updateViewLayout);
apiRouter.delete('/views/:id', deleteView);

apiRouter.post('/views/widgets', createWidget);
apiRouter.put('/views/widgets/:id', updateWidget);
apiRouter.delete('/views/widgets/:id', deleteWidget);

apiRouter.get('/views/widgets/:id/data', getWidgetData); // Dashboard execution
apiRouter.post('/views/execute', executeLivePreview);    // Live Preview execution

// --- DASHBOARD SHARING (public view-only links; management side) ---
// Creating a public link is a Pro+ feature. Viewing is public (see publicShareRouter).
apiRouter.post('/shares', requirePlan('pro'), createShare);
apiRouter.get('/shares', listShares);
apiRouter.patch('/shares/:id', updateShare);
apiRouter.delete('/shares/:id', revokeShare);

// OTLP
const otlpRouter = express.Router();

// Apply a dedicated high-throughput rate limiter for OTel payloads
const otlpLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 2000, standardHeaders: true, legacyHeaders: false });

// OTLP requires high body limits as batches can be quite large
otlpRouter.use(express.json({ limit: '10mb' }));
otlpRouter.use(otlpLimiter);
otlpRouter.use(authenticateOtlp); // Secure the gateway
otlpRouter.use(requireIngestionQuota);

// Standard OTLP HTTP JSON Endpoints
otlpRouter.post('/v1/traces', ingestOtlpTraces);
otlpRouter.post('/v1/logs', ingestOtlpLogs);

// ============================================================================
// ORGANIZATION API
// ============================================================================
apiRouter.post('/org', requireOrgCreationQuota, createOrganization);
apiRouter.get('/org', listOrganizations);
apiRouter.get('/org/:orgId', getOrganization);
apiRouter.put('/org/:orgId', updateOrganization);
apiRouter.delete('/org/:orgId', deleteOrganization);

apiRouter.get('/org/:orgId/members', listMembers);
apiRouter.put('/org/:orgId/members/:memberId', updateMember);
apiRouter.delete('/org/:orgId/members/:memberId', removeMember);
apiRouter.post('/org/:orgId/members/:memberId/transfer', transferOwnership);

apiRouter.post('/org/:orgId/invitations', sendInvitation);
apiRouter.get('/org/:orgId/invitations', listInvitations);
apiRouter.delete('/org/:orgId/invitations/:invitationId', revokeInvitation);

apiRouter.post('/org/invitations/accept', acceptInvitation);

// ============================================================================
// BILLING & MONETIZATION API
// ============================================================================
// Billing Profile
apiRouter.get('/billing/storage-stats', getStorageStats);
apiRouter.get('/billing/transactions', getTransactions);
apiRouter.get('/billing/transactions/:transactionId/receipt', getTransactionReceipt); 
apiRouter.post('/billing/cancel', cancelSubscription);
apiRouter.post('/billing/change-plan', changePlan);
apiRouter.post('/billing/checkout-session', createCheckoutSession);

const billingRouter = express.Router();

// Public/Webhook Routes (NO User Auth)
billingRouter.get('/plans', getActivePlans);
billingRouter.post('/paddle-webhook', webhookLimiter, handlePaddleWebhook);
billingRouter.post('/dodo-webhook', webhookLimiter, handleDodoWebhook);

// Protected Billing Routes (Requires User Auth + Workspace Context)
billingRouter.get('/subscription', authenticateUser, requireOtpVerified(), resolveWorkspace, getCurrentSubscription);

// ============================================================================
// DATA IMPORT / EXPORT API
// ============================================================================
// Rate limiter for data operations (stricter than general API)
const dataExportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,                  // 10 exports per hour per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Export rate limit exceeded. Please try again later.' },
});

const dataImportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,                   // 5 imports per hour per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Import rate limit exceeded. Please try again later.' },
});

// Config export/import (fits within the default 1MB body limit)
apiRouter.get('/data/export/config', dataExportLimiter, exportConfig);
apiRouter.post('/data/import/config/preview', dataImportLimiter, previewConfigImport);
apiRouter.post('/data/import/config', dataImportLimiter, importConfig);

// Telemetry export (request body is small — just type/time filters)
apiRouter.post('/data/export/telemetry', dataExportLimiter, exportTelemetry);

// NOTE: Telemetry import is mounted as a separate router below (before the
// global body parser) because it needs a 50MB body limit. See dataImportRouter.

// User Profile
apiRouter.post('/user/sync', syncUser);
apiRouter.delete('/user/account', deleteAccount);

// --- AI ASSISTANT CONVERSATIONS ---
const aiConversationLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
apiRouter.post('/ai/conversations', aiConversationLimiter, createConversation);
apiRouter.get('/ai/conversations', aiConversationLimiter, listConversations);
apiRouter.get('/ai/conversations/:id', aiConversationLimiter, getConversation);
apiRouter.patch('/ai/conversations/:id', aiConversationLimiter, updateConversation);
apiRouter.delete('/ai/conversations/:id', aiConversationLimiter, deleteConversation);
apiRouter.post('/ai/conversations/:id/messages', aiConversationLimiter, appendMessages);

// Dynamic Schema Inference
apiRouter.get('/schema', getDynamicSchema);

// Dashboard Capabilities (Time Range Picker)
apiRouter.get('/dashboard/capabilities', getDashboardCapabilities);


// --- Mounting Routes (CRITICAL ORDER) ---

// Mount the Billing router
app.use('/api/billing', billingRouter);

// Mount Ingest.
// Matches /api/ingest/* strictly.
app.use('/api/ingest', ingestRouter);

// Mount the OTLP router
app.use('/api/otlp', otlpRouter);

// Auth OTP Routes (Require Firebase Auth, NOT workspace context)
const authRouter = express.Router();
authRouter.use(authenticateUser);
authRouter.get('/otp/status', apiLimiter, getOtpStatus);
authRouter.post('/otp/send', otpSendLimiter, sendOtp);
authRouter.post('/otp/verify', otpVerifyLimiter, verifyOtp);
authRouter.get('/session', apiLimiter, getAuthSession);
authRouter.post('/revoke-sessions', apiLimiter, revokeSessions);
app.use('/api/auth', authRouter);

// --- PUBLIC DASHBOARD SHARES (No Auth Required) ---
// Unauthenticated, view-only access to a single dashboard via a secret token.
// CRITICAL: mounted BEFORE the blanket `/api` routers below (dataImportRouter and
// apiRouter both run authenticateUser on every `/api/*` request), otherwise these
// public routes would be shadowed and 401. Every route resolves the token into a
// trusted ownerId (resolveShareContext) and pins the request to the exact shared
// resource (enforceShareScope). Only read endpoints are exposed — explicit allowlist.
const publicShareRouter = express.Router();

const shareViewLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120, // per IP across all public share reads
  standardHeaders: true,
  legacyHeaders: false,
});
publicShareRouter.use(shareViewLimiter);

// Metadata (tells the public page which dashboard to render)
publicShareRouter.get('/:token', resolveShareContext, getSharedMeta);

// APM
publicShareRouter.get('/:token/apm/:id/stats', resolveShareContext, enforceShareScope('apm'), applyShareTimeRange, cachePublicShare(), getApmStats);
publicShareRouter.get('/:token/apm/:id/runtime', resolveShareContext, enforceShareScope('apm'), applyShareTimeRange, cachePublicShare(), getRuntimeStats);
publicShareRouter.get('/:token/apm/:id/invocations', resolveShareContext, enforceShareScope('apm'), applyShareTimeRange, cachePublicShare(), getInvocations);
publicShareRouter.get('/:token/apm/:id/trace/:traceId', resolveShareContext, enforceShareScope('apm'), cachePublicShare(), getTraceDetail);
publicShareRouter.get('/:token/apm/:id/trace/:traceId/errors', resolveShareContext, enforceShareScope('apm'), cachePublicShare(), getTraceErrors);

// RUM
publicShareRouter.get('/:token/rum/:id/dashboard', resolveShareContext, enforceShareScope('rum'), applyShareTimeRange, cachePublicShare(), getRumDashboard);
publicShareRouter.get('/:token/rum/:id/sessions', resolveShareContext, enforceShareScope('rum'), applyShareTimeRange, cachePublicShare(), getRumSessions);
publicShareRouter.get('/:token/rum/:id/sessions/:sessionId', resolveShareContext, enforceShareScope('rum'), cachePublicShare(), getRumSessionDetail);
publicShareRouter.get('/:token/rum/:id/trace/:traceId', resolveShareContext, enforceShareScope('rum'), cachePublicShare(), getRumTraceDetail);

// Uptime
publicShareRouter.get('/:token/uptime/:id/stats', resolveShareContext, enforceShareScope('uptime'), applyShareTimeRange, cachePublicShare(), getMonitorStats);

// Status Boards (centralized uptime dashboard / public status page).
// The board's monitor target URLs are stripped from these payloads (see getBoardSummary).
publicShareRouter.get('/:token/monitor-board/:id', resolveShareContext, enforceShareScope('monitorboard'), cachePublicShare(), getBoardById);
publicShareRouter.get('/:token/monitor-board/:id/summary', resolveShareContext, enforceShareScope('monitorboard'), applyShareTimeRange, cachePublicShare(), getBoardSummary);

// Database
publicShareRouter.get('/:token/database/:id/stats', resolveShareContext, enforceShareScope('database'), applyShareTimeRange, cachePublicShare(), getDatabaseStats);

// Queue
publicShareRouter.get('/:token/queue/:id/stats', resolveShareContext, enforceShareScope('queue'), applyShareTimeRange, cachePublicShare(), getQueueStats);

// Firebase
publicShareRouter.get('/:token/firebase/:id/stats', resolveShareContext, enforceShareScope('firebase'), applyShareTimeRange, cachePublicShare(), getFirebaseStats);

// AI Monitoring
publicShareRouter.get('/:token/ai/observability/:id/stats', resolveShareContext, enforceShareScope('ai'), applyShareTimeRange, cachePublicShare(), getAiStats);
publicShareRouter.get('/:token/ai/observability/:id/traces', resolveShareContext, enforceShareScope('ai'), applyShareTimeRange, cachePublicShare(), getAiTraces);
publicShareRouter.get('/:token/ai/observability/:id/generations', resolveShareContext, enforceShareScope('ai'), applyShareTimeRange, cachePublicShare(), getAiGenerations);
publicShareRouter.get('/:token/ai/observability/:id/consumers', resolveShareContext, enforceShareScope('ai'), applyShareTimeRange, cachePublicShare(), getAiConsumers);
publicShareRouter.get('/:token/ai/observability/:id/reliability', resolveShareContext, enforceShareScope('ai'), applyShareTimeRange, cachePublicShare(), getAiReliability);
publicShareRouter.get('/:token/ai/observability/:id/trace/:traceId', resolveShareContext, enforceShareScope('ai'), cachePublicShare(), getAiTraceDetail);

// Background Tasks
publicShareRouter.get('/:token/task/:id/dashboard', resolveShareContext, enforceShareScope('task'), applyShareTimeRange, cachePublicShare(), getTaskServiceDashboard);
publicShareRouter.get('/:token/task/:id/entity/:taskName', resolveShareContext, enforceShareScope('task'), applyShareTimeRange, cachePublicShare(), getTaskEntityDetail);
publicShareRouter.get('/:token/task/:id/run/:runId', resolveShareContext, enforceShareScope('task'), cachePublicShare(), getTaskRunDetail);

// Web Analytics
publicShareRouter.get('/:token/web/:id/stats', resolveShareContext, enforceShareScope('web'), applyShareTimeRange, cachePublicShare(), getWebStats);
publicShareRouter.get('/:token/web/:id/events', resolveShareContext, enforceShareScope('web'), applyShareTimeRange, cachePublicShare(), getWebEvents);
publicShareRouter.get('/:token/web/:id/realtime', resolveShareContext, enforceShareScope('web'), cachePublicShare(5), getWebRealtime);
publicShareRouter.get('/:token/web/:id/funnels', resolveShareContext, enforceShareScope('web'), cachePublicShare(), listFunnels);
publicShareRouter.get('/:token/web/:id/funnels/:funnelId/analyze', resolveShareContext, enforceShareScope('web'), applyShareTimeRange, cachePublicShare(), analyzeFunnel);
publicShareRouter.get('/:token/web/:id/annotations', resolveShareContext, enforceShareScope('web'), applyShareTimeRange, cachePublicShare(), listAnnotations);
publicShareRouter.get('/:token/web/:id/retention', resolveShareContext, enforceShareScope('web'), applyShareTimeRange, cachePublicShare(), getWebRetention);
publicShareRouter.get('/:token/web/:id/paths', resolveShareContext, enforceShareScope('web'), applyShareTimeRange, cachePublicShare(), getWebPaths);

// Servers (VPS)
publicShareRouter.get('/:token/vps/:id/stats', resolveShareContext, enforceShareScope('vps'), applyShareTimeRange, cachePublicShare(), getVpsStats);

// Saved Views (custom dashboards) — widget MQL is stripped from these payloads.
// The `/:id` variant lets the reused canvas component fetch `/views/:id` (id is
// pinned to the share's scope by enforceShareScope); both resolve the same view.
publicShareRouter.get('/:token/views', resolveShareContext, enforceShareScope('savedview'), getSharedView);
publicShareRouter.get('/:token/views/:id', resolveShareContext, enforceShareScope('savedview'), getSharedView);
publicShareRouter.get('/:token/views/widgets/:widgetId/data', resolveShareContext, enforceShareScope('savedview'), applyShareTimeRange, cachePublicShare(), getSharedWidgetData);

app.use('/api/public/shares', publicShareRouter);

// Public Web Analytics Query API (API-key auth, not user JWT). MUST be mounted
// before any `/api`-level router that applies `authenticateUser` (dataImportRouter
// and apiRouter both do, via router-level middleware that runs even when no route
// matches) — otherwise a Bearer API key is rejected as an invalid Firebase token.
const webQueryRouter = express.Router();
webQueryRouter.get('/overview', apiOverview);
webQueryRouter.get('/timeseries', apiTimeseries);
webQueryRouter.get('/breakdown', apiBreakdown);
webQueryRouter.get('/events', apiEvents);
app.use('/api/v1/web', webApiLimiter, webApiKeyAuth, webQueryRouter);

// Telemetry Import Router (separate from apiRouter for higher body limit)
// Mounted before the apiRouter so it's matched first. Uses its own body parser
// with a 50MB limit since telemetry payloads can be large.
const dataImportRouter = express.Router();
dataImportRouter.use(express.json({ limit: '50mb' }));
dataImportRouter.use(authenticateUser);
dataImportRouter.use(requireOtpVerified());
dataImportRouter.use(resolveWorkspace);
dataImportRouter.post('/data/import/telemetry', dataImportLimiter, importTelemetry);
app.use('/api', dataImportRouter);

// Public Organization Routes (No Auth Required)
app.get('/api/org/invitations/details', getInvitationDetails);

// Mount Dashboard API SECOND.
// This catches everything else starting with /api (like /api/vps/...)
// and applies the authenticateUser middleware.
app.use('/api', apiRouter);

// Health Check (Public)
app.get('/health', (req, res) => res.send('Senzor Core: Online'));
app.get('/status', getRandomStatus);

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

// --- Graceful Shutdown ---
process.on('SIGTERM', async () => {
  logger.info('[Server] SIGTERM received, shutting down...');
  await shutdownQueues();
  await shutdownCache();
  httpServer.close();
  mongoose.connection.close();
});