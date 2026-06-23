import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// --- ALL READ-ONLY CONTROLLERS ---
import { listServices as listApmServices } from '../controllers/apm/main';
import { getApmStats } from '../controllers/apm/stats';
import { getRuntimeStats } from '../controllers/apm/runtimeStats';
import { getInvocations, getTraceDetail } from '../controllers/apm/traces';
import { listVps, getVpsStats } from '../controllers/vps';
import { listWebsites } from '../controllers/web/main';
import { getWebStats } from '../controllers/web/webStats';
import { listMonitors, getMonitorStats } from '../controllers/monitor';
import { listDatabases } from '../controllers/database/main';
import { getDatabaseStats } from '../controllers/database/stats';
import { listQueueSources } from '../controllers/queue/main';
import { getQueueStats, getQueueEntityDetail } from '../controllers/queue/stats';
import { getQueueExecutions } from '../controllers/queue/correlation';
import {
  listAiSources, getAiStats, getAiTraces, getAiTraceDetail, getAiConsumers,
} from '../controllers/ai/observability';
import { listFirebaseServices } from '../controllers/firebase/main';
import { getFirebaseStats } from '../controllers/firebase/stats';
import { listTaskServices } from '../controllers/task/main';
import { getTaskServiceDashboard, getTaskEntityDetail, getTaskRunDetail } from '../controllers/task/stats';
import { getGlobalErrors, getErrorGroupDetails, getTraceErrors } from '../controllers/error';
import { listServices as listRumServices } from '../controllers/rum/main';
import { getRumDashboard, getRumTraceDetail } from '../controllers/rum/stats';
import { getDashboardLogs, getTraceLogs, getLogById } from '../controllers/logs';

import { listDestinations, listPolicies, getPolicyDetails, listIncidents, getIncidentDetail, listSilences } from '../controllers/alerts';
import { listViews, getViewById } from '../controllers/view/main';
import { getWidgetData } from '../controllers/view/engine';
import { getStorageStats, getTransactions, getTransactionReceipt, getCurrentSubscription, getActivePlans } from '../controllers/billing';
import { getDynamicSchema } from '../controllers/schema';
import { getDashboardCapabilities } from '../controllers/dashboard/capabilities';

import { simulateExpressCall, trackUsage, validateToolArgs } from "./registry";

// --- Complete Tool Definitions ---
const MCP_TOOLS = [
  // --- APM Tools ---
  {
    name: "apm_list_services",
    description: "List all active APM (Backend) services and their IDs.",
    inputSchema: { type: "object", properties: {} },
    execute: (args: any, uid: string) => simulateExpressCall(listApmServices, uid)
  },
  {
    name: "apm_get_stats",
    description: "Get performance aggregations (latency, RPS) for an APM service.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, range: { type: "string", default: "24h" } }, required: ["id"] },
    execute: (args: any, uid: string) => simulateExpressCall(getApmStats, uid, { id: args.id }, { range: args.range })
  },
  {
    name: "apm_get_invocations",
    description: "Get a list of recent HTTP trace invocations for a service.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: (args: any, uid: string) => simulateExpressCall(getInvocations, uid, { id: args.id }, { limit: 20 })
  },
  {
    name: "apm_get_trace_detail",
    description: "Get the full execution waterfall (spans) for a specific traceId.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, traceId: { type: "string" } }, required: ["id", "traceId"] },
    execute: (args: any, uid: string) => simulateExpressCall(getTraceDetail, uid, { id: args.id, traceId: args.traceId })
  },
  {
    name: "apm_get_runtime_stats",
    description: "Get Node.js runtime health metrics for an APM service: event loop lag/utilization, GC frequency/duration, heap memory usage, CPU usage, and active handles.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, range: { type: "string", default: "1h" } }, required: ["id"] },
    execute: (args: any, uid: string) => simulateExpressCall(getRuntimeStats, uid, { id: args.id }, { range: args.range })
  },

  // --- RUM (Web APM) Tools ---
  {
    name: "rum_list_services",
    description: "List all active RUM (Frontend Web APM) applications.",
    inputSchema: { type: "object", properties: {} },
    execute: (args: any, uid: string) => simulateExpressCall(listRumServices, uid)
  },
  {
    name: "rum_get_dashboard",
    description: "Get Web Vitals (LCP, INP, CLS) and page views for a RUM app.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, range: { type: "string", default: "24h" } }, required: ["id"] },
    execute: (args: any, uid: string) => simulateExpressCall(getRumDashboard, uid, { id: args.id }, { range: args.range })
  },
  {
    name: "rum_get_trace_detail",
    description: "Get the frontend execution trace (XHR/Fetch spans) for a RUM traceId.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, traceId: { type: "string" } }, required: ["id", "traceId"] },
    execute: (args: any, uid: string) => simulateExpressCall(getRumTraceDetail, uid, { id: args.id, traceId: args.traceId })
  },

  // --- Background Tasks Tools ---
  {
    name: "task_list_services",
    description: "List all Background Task services.",
    inputSchema: { type: "object", properties: {} },
    execute: (args: any, uid: string) => simulateExpressCall(listTaskServices, uid)
  },
  {
    name: "task_get_dashboard",
    description: "Get job execution metrics (failures, delays, durations).",
    inputSchema: { type: "object", properties: { id: { type: "string" }, range: { type: "string", default: "24h" } }, required: ["id"] },
    execute: (args: any, uid: string) => simulateExpressCall(getTaskServiceDashboard, uid, { id: args.id }, { range: args.range })
  },
  {
    name: "task_get_entity_detail",
    description: "Get specific historical performance for a single task queue/cron name.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, taskName: { type: "string" }, range: { type: "string", default: "24h" } }, required: ["id", "taskName"] },
    execute: (args: any, uid: string) => simulateExpressCall(getTaskEntityDetail, uid, { id: args.id, taskName: args.taskName }, { range: args.range })
  },
  {
    name: "task_get_run_detail",
    description: "Get the detailed spans and metadata for a specific task runId.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, runId: { type: "string" } }, required: ["id", "runId"] },
    execute: (args: any, uid: string) => simulateExpressCall(getTaskRunDetail, uid, { id: args.id, runId: args.runId })
  },

  // --- Logs Tools ---
  {
    name: "logs_query",
    description: "Search system logs. Use filters like level:error.",
    inputSchema: { type: "object", properties: { search: { type: "string" }, range: { type: "string", default: "24h" }, limit: { type: "number", default: 20 } } },
    execute: (args: any, uid: string) => simulateExpressCall(getDashboardLogs, uid, {}, { search: args.search, range: args.range, limit: Math.min(args.limit || 20, 50) })
  },
  {
    name: "logs_get_by_id",
    description: "Get the full payload of a single log by its MongoDB _id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: (args: any, uid: string) => simulateExpressCall(getLogById, uid, { id: args.id })
  },
  {
    name: "logs_get_by_trace",
    description: "Get all logs explicitly attached to an APM/RUM traceId or Task runId.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, traceId: { type: "string" } }, required: ["id", "traceId"] },
    execute: (args: any, uid: string) => simulateExpressCall(getTraceLogs, uid, { id: args.id, traceId: args.traceId })
  },

  // --- Error Tracking Tools ---
  {
    name: "error_get_global",
    description: "Get a list of unresolved exception groups across the platform.",
    inputSchema: { type: "object", properties: {} },
    execute: (args: any, uid: string) => simulateExpressCall(getGlobalErrors, uid, {}, { status: 'unresolved', limit: 20 })
  },
  {
    name: "error_get_group_detail",
    description: "Get details and recent occurrences of a specific error fingerprint (groupId).",
    inputSchema: { type: "object", properties: { groupId: { type: "string" }, range: { type: "string", default: "24h" } }, required: ["groupId"] },
    execute: (args: any, uid: string) => simulateExpressCall(getErrorGroupDetails, uid, { groupId: args.groupId }, { range: args.range })
  },
  {
    name: "error_get_trace_errors",
    description: "Get raw error events that occurred during a specific APM traceId.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, traceId: { type: "string" } }, required: ["id", "traceId"] },
    execute: (args: any, uid: string) => simulateExpressCall(getTraceErrors, uid, { id: args.id, traceId: args.traceId })
  },

  // --- Web Analytics Tools ---
  {
    name: "web_list_websites",
    description: "List all standard Web Analytics (Non-RUM) tracking properties.",
    inputSchema: { type: "object", properties: {} },
    execute: (args: any, uid: string) => simulateExpressCall(listWebsites, uid)
  },
  {
    name: "web_get_stats",
    description: "Get pageviews, visitors, and referriers for a standard Web Analytics property.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, range: { type: "string", default: "24h" } }, required: ["id"] },
    execute: (args: any, uid: string) => simulateExpressCall(getWebStats, uid, { id: args.id }, { range: args.range })
  },

  // --- Uptime Monitor Tools ---
  {
    name: "uptime_list_monitors",
    description: "List all external uptime monitors (cron pingers).",
    inputSchema: { type: "object", properties: {} },
    execute: (args: any, uid: string) => simulateExpressCall(listMonitors, uid)
  },
  {
    name: "uptime_get_stats",
    description: "Get uptime percentage, latency, and status history for a monitor.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, range: { type: "string", default: "24h" } }, required: ["id"] },
    execute: (args: any, uid: string) => simulateExpressCall(getMonitorStats, uid, { id: args.id }, { range: args.range })
  },

  // --- Infrastructure Tools (VPS) ---
  {
    name: "vps_list",
    description: "List monitored Linux VPS servers.",
    inputSchema: { type: "object", properties: {} },
    execute: (args: any, uid: string) => simulateExpressCall(listVps, uid)
  },
  {
    name: "vps_get_stats",
    description: "Get CPU, RAM, Disk, Network, and Docker metrics for a VPS.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, range: { type: "string", default: "1h" } }, required: ["id"] },
    execute: (args: any, uid: string) => simulateExpressCall(getVpsStats, uid, { id: args.id }, { range: args.range })
  },

  // --- Firebase Monitoring Tools ---
  {
    name: "firebase_list",
    description: "List all monitored Firebase projects and their connection status.",
    inputSchema: { type: "object", properties: {} },
    execute: (args: any, uid: string) => simulateExpressCall(listFirebaseServices, uid)
  },
  {
    name: "firebase_get_stats",
    description: "Get Firebase Auth metrics: total users, active users, new signups, provider breakdown (Google, Apple, Email, etc.), MFA enrollment, and historical trends.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, range: { type: "string", default: "24h" } }, required: ["id"] },
    execute: (args: any, uid: string) => simulateExpressCall(getFirebaseStats, uid, { id: args.id }, { range: args.range })
  },

  // --- Database Tools ---
  {
    name: "database_list",
    description: "List monitored database instances (MongoDB, Redis, PostgreSQL, MySQL).",
    inputSchema: { type: "object", properties: {} },
    execute: (args: any, uid: string) => simulateExpressCall(listDatabases, uid)
  },
  {
    name: "database_get_stats",
    description: "Get database throughput and latency metrics.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, range: { type: "string", default: "1h" } }, required: ["id"] },
    execute: (args: any, uid: string) => simulateExpressCall(getDatabaseStats, uid, { id: args.id }, { range: args.range })
  },

  // --- Queue Monitoring Tools (BullMQ, RabbitMQ, Kafka, AWS SQS) ---
  {
    name: "queue_list",
    description: "List monitored queue sources (BullMQ, RabbitMQ, Kafka, AWS SQS), their broker system, mode (agentless/collector), and status.",
    inputSchema: { type: "object", properties: {} },
    execute: (args: any, uid: string) => simulateExpressCall(listQueueSources, uid)
  },
  {
    name: "queue_get_stats",
    description: "Get a queue source overview: total backlog, in-flight, dead-letter depth, consumer count, the per-queue table, and overall throughput/backlog history aggregated across all of the source's queues.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, range: { type: "string", default: "24h" } }, required: ["id"] },
    execute: (args: any, uid: string) => simulateExpressCall(getQueueStats, uid, { id: args.id }, { range: args.range })
  },
  {
    name: "queue_get_entity_detail",
    description: "Get one queue's detail within a source: backlog, dead letters, throughput (processed/sec), oldest-message age, consumers, drain ETA, net rate, and time-series history. queueName is the exact queue/topic/consumer-group name from queue_get_stats.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, queueName: { type: "string" }, range: { type: "string", default: "24h" } }, required: ["id", "queueName"] },
    execute: (args: any, uid: string) => simulateExpressCall(getQueueEntityDetail, uid, { id: args.id, queueName: encodeURIComponent(args.queueName) }, { range: args.range })
  },
  {
    name: "queue_get_executions",
    description: "Get instrumented consumer executions correlated to a queue (from @senzops/apm-node): run count, failure rate, dead-letter count, average processing time, and recent runs. Explains WHY a queue's backlog is growing or draining.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, queue: { type: "string" }, range: { type: "string", default: "24h" } }, required: ["id", "queue"] },
    execute: (args: any, uid: string) => simulateExpressCall(getQueueExecutions, uid, { id: args.id }, { queue: args.queue, range: args.range })
  },

  // --- Alerts & Incident Tools ---
  {
    name: "alerts_list_destinations",
    description: "List all configured alert destinations (channels) like Webhooks or Slack.",
    inputSchema: { type: "object", properties: {} },
    execute: (args: any, uid: string) => simulateExpressCall(listDestinations, uid)
  },
  {
    name: "alerts_list_policies",
    description: "List all alert policies and their summary statistics including open incident counts.",
    inputSchema: { type: "object", properties: {} },
    execute: (args: any, uid: string) => simulateExpressCall(listPolicies, uid)
  },
  {
    name: "alerts_get_policy_details",
    description: "Get detailed information about a specific alert policy, its evaluation conditions, and incident history.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: (args: any, uid: string) => simulateExpressCall(getPolicyDetails, uid, { id: args.id })
  },
  {
    name: "alerts_list_incidents",
    description: "List alert incidents with filtering by status (open/acknowledged/resolved), severity (critical/high/medium/low), and policyId. Returns incidents with status counts.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["all", "open", "acknowledged", "resolved"], default: "all" },
        severity: { type: "string", enum: ["all", "critical", "high", "medium", "low"], default: "all" },
        policyId: { type: "string" },
        limit: { type: "number", default: 50 },
        sort: { type: "string", default: "-openedAt" }
      }
    },
    execute: (args: any, uid: string) => simulateExpressCall(listIncidents, uid, {}, {
      status: args.status,
      severity: args.severity,
      policyId: args.policyId,
      limit: Math.min(args.limit || 50, 100),
      sort: args.sort || '-openedAt'
    })
  },
  {
    name: "alerts_get_incident_detail",
    description: "Get full details of a specific incident: triggering condition, policy, severity, timeline of events, and associated metadata.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: (args: any, uid: string) => simulateExpressCall(getIncidentDetail, uid, { id: args.id })
  },
  {
    name: "alerts_list_silences",
    description: "List all active and scheduled alert silences (maintenance windows) with their scope and duration.",
    inputSchema: { type: "object", properties: {} },
    execute: (args: any, uid: string) => simulateExpressCall(listSilences, uid)
  },

  // --- Saved Views (Canvas Dashboards) Tools ---
  {
    name: "views_list_dashboards",
    description: "List all custom saved views (dashboards) and their layouts.",
    inputSchema: { type: "object", properties: {} },
    execute: (args: any, uid: string) => simulateExpressCall(listViews, uid)
  },
  {
    name: "views_get_dashboard",
    description: "Get the layout and widget configurations for a specific custom dashboard.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: (args: any, uid: string) => simulateExpressCall(getViewById, uid, { id: args.id })
  },
  {
    name: "views_get_widget_data",
    description: "Execute the aggregation pipeline for a specific dashboard widget and return the computed data.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, range: { type: "string", default: "24h" } }, required: ["id"] },
    execute: (args: any, uid: string) => simulateExpressCall(getWidgetData, uid, { id: args.id }, { range: args.range })
  },

  // --- AI Monitoring (LLM Observability) Tools ---
  {
    name: "ai_list_sources",
    description: "List all AI Monitoring sources (LLM observability projects) and their IDs, type (server/browser), and last-seen time.",
    inputSchema: { type: "object", properties: {} },
    execute: (args: any, uid: string) => simulateExpressCall(listAiSources, uid)
  },
  {
    name: "ai_get_stats",
    description: "Get an AI source overview for a time range: total cost (USD), LLM calls, token usage, error rate, latency percentiles (p50/p95/p99), cost/token/latency time series, and breakdowns by model, provider and operation.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, range: { type: "string", default: "24h" } }, required: ["id"] },
    execute: (args: any, uid: string) => simulateExpressCall(getAiStats, uid, { id: args.id }, { range: args.range })
  },
  {
    name: "ai_get_consumers",
    description: "Get the top users and top sessions for an AI source by cost (also calls, tokens, traces). Useful for attributing LLM spend to end-users or conversations.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, range: { type: "string", default: "24h" } }, required: ["id"] },
    execute: (args: any, uid: string) => simulateExpressCall(getAiConsumers, uid, { id: args.id }, { range: args.range })
  },
  {
    name: "ai_get_traces",
    description: "List recent AI traces (workflow groupings) for a source with status, generation count, cost, tokens and latency. Supports filtering by status ('ok'|'error') and sessionId.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, range: { type: "string", default: "24h" }, status: { type: "string" }, sessionId: { type: "string" }, limit: { type: "number", default: 50 } }, required: ["id"] },
    execute: (args: any, uid: string) => simulateExpressCall(getAiTraces, uid, { id: args.id }, { range: args.range, status: args.status, sessionId: args.sessionId, limit: args.limit })
  },
  {
    name: "ai_get_trace_detail",
    description: "Get one AI trace and its full generation waterfall (each LLM/tool/retrieval/embedding call with provider, model, tokens, cost, latency, finish reason and status).",
    inputSchema: { type: "object", properties: { id: { type: "string" }, traceId: { type: "string" } }, required: ["id", "traceId"] },
    execute: (args: any, uid: string) => simulateExpressCall(getAiTraceDetail, uid, { id: args.id, traceId: args.traceId })
  },

  // --- Dynamic Schema Explorer Tool ---
  {
    name: "schema_get_dynamic",
    description: "Get the dynamically inferred schema map for all telemetry data types. Highly useful for generating precise MongoDB Aggregation Pipelines.",
    inputSchema: { type: "object", properties: {} },
    execute: (args: any, uid: string) => simulateExpressCall(getDynamicSchema, uid)
  },

  // --- Billing & Subscription Tools ---
  {
    name: "billing_get_storage_stats",
    description: "Get current platform storage limits and actual usage statistics for the user.",
    inputSchema: { type: "object", properties: {} },
    execute: (args: any, uid: string) => simulateExpressCall(getStorageStats, uid)
  },
  {
    name: "billing_get_subscription",
    description: "Get the user's current active subscription details, tier, and status.",
    inputSchema: { type: "object", properties: {} },
    execute: (args: any, uid: string) => simulateExpressCall(getCurrentSubscription, uid)
  },
  {
    name: "billing_get_transactions",
    description: "Get the user's billing transaction and payment history.",
    inputSchema: { type: "object", properties: {} },
    execute: (args: any, uid: string) => simulateExpressCall(getTransactions, uid)
  },
  {
    name: "billing_get_transaction_receipt",
    description: "Get the downloadable receipt details or link for a specific billing transaction.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string" } }, required: ["transactionId"] },
    execute: (args: any, uid: string) => simulateExpressCall(getTransactionReceipt, uid, { transactionId: args.transactionId })
  },
  {
    name: "billing_get_active_plans",
    description: "List all currently available public pricing tiers and platform plans.",
    inputSchema: { type: "object", properties: {} },
    execute: (args: any, uid: string) => simulateExpressCall(getActivePlans, uid)
  },

  // --- Platform Capabilities ---
  {
    name: "platform_get_capabilities",
    description: "Get the user's data retention limits per service type and all available time range options. Essential for constructing valid time range queries.",
    inputSchema: { type: "object", properties: {} },
    execute: (args: any, uid: string) => simulateExpressCall(getDashboardCapabilities, uid)
  }
];

export const registerSenzorTools = (server: Server, ownerId: string) => {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as any }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    trackUsage(ownerId, name);

    const tool = MCP_TOOLS.find(t => t.name === name);
    if (!tool) throw new Error(`Tool not found: ${name}`);

    try {
      // Validate/coerce arguments against the tool's inputSchema before dispatch.
      // (The low-level Server does not validate, so malformed input would
      // otherwise reach the controllers unchecked.)
      const validatedArgs = validateToolArgs(tool.inputSchema as any, args);
      const result = await tool.execute(validatedArgs, ownerId);

      // Pass controller errors (400/404s) elegantly back to the LLM
      if (result.status >= 400) {
        return {
          content: [{ type: "text", text: `API Error ${result.status}: ${JSON.stringify(result.data)}` }],
          isError: true
        };
      }

      // Always return a text representation (universal client support). When the
      // payload is a JSON object, also attach `structuredContent` so capable
      // clients get machine-parseable data without re-parsing the text. Arrays
      // and primitives are omitted — structuredContent must be an object per spec.
      const isPlainObject = result.data !== null && typeof result.data === 'object' && !Array.isArray(result.data);
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
        ...(isPlainObject ? { structuredContent: result.data } : {}),
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Execution Exception: ${error.message}` }],
        isError: true
      };
    }
  });
};