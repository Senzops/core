import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import mongoose from "mongoose";

// Models
import { ApmService, ApmTrace } from "../models/Apm";
import { RumService } from "../models/Rum";
import { TaskService } from "../models/Task";
import { LogEvent } from "../models/Log";
import { ErrorGroup } from "../models/Error";
import { McpUsage } from "../models/Mcp";
import { DatabaseService, DbMetric } from "../models/Database";
import { Monitor } from "../models/Monitor";
import { Vps, VpsRun } from "../models/Vps";

// --- Usage Tracking (Fire & Forget) ---
const trackUsage = (ownerId: string, toolName: string) => {
  const bucketTime = new Date();
  bucketTime.setMinutes(0, 0, 0); // Bucket by hour for efficient querying

  McpUsage.updateOne(
    { ownerId, timestamp: bucketTime },
    { $inc: { totalQueries: 1, [`toolCalls.${toolName}`]: 1 } },
    { upsert: true }
  ).catch(() => { });
};

export const registerSenzorTools = (server: Server, ownerId: string) => {

  // --- 1. REGISTER TOOLS SCHEMA ---
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        // APM & General
        {
          name: "list_services",
          description: "List all active APM, RUM, and Background Task services.",
          inputSchema: { type: "object", properties: {} }
        },
        {
          name: "get_apm_trace",
          description: "Fetch the detailed execution waterfall, spans, and metadata for a specific backend traceId.",
          inputSchema: {
            type: "object",
            properties: { traceId: { type: "string", description: "The W3C traceId" } },
            required: ["traceId"]
          }
        },
        // Logs & Errors
        {
          name: "query_logs",
          description: "Search system logs. Use New Relic style syntax (e.g. level:error message:timeout).",
          inputSchema: {
            type: "object",
            properties: {
              search: { type: "string", description: "Search query string" },
              limit: { type: "number", description: "Max logs to return (capped at 50 for safety)" }
            }
          }
        },
        {
          name: "get_unresolved_errors",
          description: "Retrieve a list of the most frequent, currently unresolved exception groups across the platform.",
          inputSchema: { type: "object", properties: {} }
        },
        // Infrastructure (VPS)
        {
          name: "list_vps_servers",
          description: "List all monitored VPS/Server instances to get their IDs and overall status.",
          inputSchema: { type: "object", properties: {} }
        },
        {
          name: "get_vps_metrics",
          description: "Get the absolute latest system telemetry (CPU, Memory, Disk, Network, Docker) for a specific VPS.",
          inputSchema: {
            type: "object",
            properties: { vpsId: { type: "string", description: "The VPS ID" } },
            required: ["vpsId"]
          }
        },
        // Databases
        {
          name: "list_databases",
          description: "List all monitored databases (MongoDB, Redis, etc.) and their connection status.",
          inputSchema: { type: "object", properties: {} }
        },
        {
          name: "get_database_metrics",
          description: "Get the latest performance metrics (throughput, latency, memory, ops) for a specific database.",
          inputSchema: {
            type: "object",
            properties: { dbId: { type: "string", description: "The Database ID" } },
            required: ["dbId"]
          }
        },
        // Uptime
        {
          name: "list_uptime_monitors",
          description: "List all external uptime monitors and their current health status (up/down).",
          inputSchema: { type: "object", properties: {} }
        }
      ]
    };
  });

  // --- 2. HANDLE TOOL EXECUTION ---
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Asynchronously log usage metrics for the dashboard
    trackUsage(ownerId, name);

    try {
      switch (name) {

        // --- SOFTWARE APM & TASKS ---
        case "list_services": {
          const [apm, rum, tasks] = await Promise.all([
            ApmService.find({ ownerId }).select('_id name framework status').lean(),
            RumService.find({ ownerId }).select('_id name domains').lean(),
            TaskService.find({ ownerId }).select('_id name status').lean()
          ]);
          return { content: [{ type: "text", text: JSON.stringify({ APM: apm, RUM: rum, BackgroundTasks: tasks }, null, 2) }] };
        }

        case "get_apm_trace": {
          const { traceId } = args as any;
          // Security: Explicitly match ownerId via service lookup
          const userServices = await ApmService.find({ ownerId }).select('_id').lean();
          const serviceIds = userServices.map(s => s._id);

          const trace = await ApmTrace.findOne({ traceId, serviceId: { $in: serviceIds } }).lean();
          if (!trace) return { content: [{ type: "text", text: "Trace not found or access denied." }] };

          return { content: [{ type: "text", text: JSON.stringify(trace, null, 2) }] };
        }

        // --- LOGS & ERRORS ---
        case "query_logs": {
          const searchArgs = args as any;
          const limit = Math.min(searchArgs.limit || 20, 50); // Hard CAP against AI context overflow

          // Basic text search fallback (you can import parseLogQuery here for full New Relic syntax)
          const query: any = { ownerId };
          if (searchArgs.search) {
            query.$or = [
              { message: { $regex: searchArgs.search, $options: 'i' } },
              { level: { $regex: `^${searchArgs.search}$`, $options: 'i' } }
            ];
          }

          const logs = await LogEvent.find(query).sort({ timestamp: -1 }).limit(limit).select('-__v -ownerId').lean();
          return { content: [{ type: "text", text: JSON.stringify(logs, null, 2) }] };
        }

        case "get_unresolved_errors": {
          const errors = await ErrorGroup.find({ ownerId, status: 'unresolved' })
            .sort({ lastSeen: -1 })
            .limit(15) // Hard CAP
            .select('fingerprint errorClass message firstSeen lastSeen totalCount')
            .lean();
          return { content: [{ type: "text", text: JSON.stringify(errors, null, 2) }] };
        }

        // --- INFRASTRUCTURE (VPS) ---
        case "list_vps_servers": {
          const servers = await Vps.find({ ownerId }).select('_id name status metadata lastSeen').lean();
          return { content: [{ type: "text", text: JSON.stringify(servers, null, 2) }] };
        }

        case "get_vps_metrics": {
          const { vpsId } = args as any;
          const vps = await Vps.findOne({ _id: vpsId, ownerId }).lean();
          if (!vps) return { content: [{ type: "text", text: "VPS not found or access denied." }] };

          const latestRun = await VpsRun.findOne({ vpsId }).sort({ createdAt: -1 }).select('metrics createdAt isOnline').lean();
          return { content: [{ type: "text", text: JSON.stringify(latestRun || { status: "No recent metrics" }, null, 2) }] };
        }

        // --- DATABASES ---
        case "list_databases": {
          const dbs = await DatabaseService.find({ ownerId }).select('_id name type status interval lastCheck errorMessage').lean();
          return { content: [{ type: "text", text: JSON.stringify(dbs, null, 2) }] };
        }

        case "get_database_metrics": {
          const { dbId } = args as any;
          const db = await DatabaseService.findOne({ _id: dbId, ownerId }).lean();
          if (!db) return { content: [{ type: "text", text: "Database not found or access denied." }] };

          const latestMetric = await DbMetric.findOne({ dbId }).sort({ timestamp: -1 }).select('-__v -dbId').lean();
          return { content: [{ type: "text", text: JSON.stringify(latestMetric || { status: "No recent metrics" }, null, 2) }] };
        }

        // --- UPTIME MONITORS ---
        case "list_uptime_monitors": {
          const monitors = await Monitor.find({ ownerId }).select('_id name url status interval lastCheck nextCheck').lean();
          return { content: [{ type: "text", text: JSON.stringify(monitors, null, 2) }] };
        }

        default:
          throw new Error(`Tool not found: ${name}`);
      }
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error executing tool: ${error.message}` }],
        isError: true
      };
    }
  });
};