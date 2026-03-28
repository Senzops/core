import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { registerSenzorTools } from '../mcp/tools';
import { McpApiKey, McpUsage } from '../models/Mcp';
import { logger } from '../utils/logger';

// ============================================================================
// PART 1: FRONTEND DASHBOARD CONTROLLERS (REST API)
// ============================================================================

// --- 1. Get all MCP Keys ---
export const getMcpKeys = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const keys = await McpApiKey.find({ ownerId: uid })
      .select('-__v')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ keys });
  } catch (error) {
    next(error);
  }
};

// --- 2. Create a new MCP Key ---
export const createMcpKey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'A valid integration name is required' });
    }

    const rawKey = `sz_mcp_${crypto.randomBytes(24).toString('hex')}`;

    const newKey = await McpApiKey.create({
      ownerId: uid,
      name,
      key: rawKey,
      status: 'active'
    });

    res.status(201).json({
      _id: newKey._id,
      name: newKey.name,
      key: rawKey, // Shown exactly ONCE to the frontend
      createdAt: newKey.createdAt
    });
  } catch (error) {
    next(error);
  }
};

// --- 3. Revoke an MCP Key ---
export const revokeMcpKey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;

    // We do a soft delete (update status) so the user can still see its history in the UI
    const key = await McpApiKey.findOneAndUpdate(
      { _id: id, ownerId: uid },
      { status: 'revoked' },
      { new: true }
    );

    if (!key) return res.status(404).json({ error: 'Key not found' });
    res.json({ success: true, message: 'Key successfully revoked' });
  } catch (error) {
    next(error);
  }
};

// --- 4. Get MCP Usage Analytics (Graph & Stats) ---
export const getMcpUsage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const range = req.query.range as string || '7d';

    const startDate = new Date();
    if (range === '24h') startDate.setHours(startDate.getHours() - 24);
    else if (range === '7d') startDate.setDate(startDate.getDate() - 7);
    else if (range === '30d') startDate.setDate(startDate.getDate() - 30);
    else startDate.setDate(startDate.getDate() - 7); // Default fallback

    let dateFormat = "%Y-%m-%dT%H:00:00.000Z";
    if (range === '7d' || range === '30d') dateFormat = "%Y-%m-%d";

    // 4A. Aggregate Trend Graph
    const trendRaw = await McpUsage.aggregate([
      { $match: { ownerId: uid, timestamp: { $gte: startDate } } },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat, date: "$timestamp" } },
          queries: { $sum: "$totalQueries" }
        }
      },
      { $sort: { "_id": 1 } }
    ]);

    // 4B. Calculate Total Queries
    const statsAgg = await McpUsage.aggregate([
      { $match: { ownerId: uid, timestamp: { $gte: startDate } } },
      { $group: { _id: null, totalQueries: { $sum: "$totalQueries" } } }
    ]);

    // 4C. Calculate Top Tools
    const usages = await McpUsage.find({ ownerId: uid, timestamp: { $gte: startDate } }).select('toolCalls').lean();
    const mergedToolCalls: Record<string, number> = {};

    usages.forEach(u => {
      if (u.toolCalls) {
        Object.entries(u.toolCalls).forEach(([tool, count]) => {
          mergedToolCalls[tool] = (mergedToolCalls[tool] || 0) + (count as number);
        });
      }
    });

    // 4D. Fill Time Gaps for smooth UI charts
    const trend = [];
    const now = new Date();
    let current = new Date(startDate);
    if (range === '24h') current.setMinutes(0, 0, 0);
    else current.setHours(0, 0, 0, 0);

    const dataMap = new Map(trendRaw.map((item: any) => [item._id, item]));

    while (current <= now) {
      let key = '';
      if (range === '24h') key = current.toISOString().slice(0, 13) + ":00:00.000Z";
      else key = current.toISOString().slice(0, 10);

      trend.push(dataMap.get(key) || { _id: key, queries: 0 });

      if (range === '24h') current.setHours(current.getHours() + 1);
      else current.setDate(current.getDate() + 1);
    }

    res.json({
      totalQueries: statsAgg[0]?.totalQueries || 0,
      toolCalls: mergedToolCalls,
      trend
    });
  } catch (error) {
    next(error);
  }
};


// ============================================================================
// PART 2: AI AGENT CONTROLLERS (SSE TRANSPORT PROTOCOL)
// ============================================================================

interface ActiveSession {
  transport: SSEServerTransport;
  server: Server;
  ownerId: string;
}
const activeSessions = new Map<string, ActiveSession>();

export const handleMcpSse = async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).user.uid;

    const mcpServer = new Server(
      { name: "Senzor Observability MCP", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    registerSenzorTools(mcpServer, ownerId);

    const transport = new SSEServerTransport("/api/mcp/messages", res);
    await mcpServer.connect(transport);

    activeSessions.set(transport.sessionId, { transport, server: mcpServer, ownerId });
    logger.info(`[MCP] AI connection established for owner: ${ownerId} (Session: ${transport.sessionId})`);

    res.on('close', () => {
      activeSessions.delete(transport.sessionId);
      mcpServer.close();
    });

  } catch (error) {
    logger.error('[MCP SSE Error]', error);
    if (!res.headersSent) res.status(500).json({ error: "Failed to establish MCP connection" });
  }
};

export const handleMcpMessage = async (req: Request, res: Response) => {
  try {
    const sessionId = req.query.sessionId as string;
    if (!sessionId) return res.status(400).send("Missing sessionId query parameter");

    const session = activeSessions.get(sessionId);
    if (!session) return res.status(404).send("MCP Session not found or expired");

    await session.transport.handlePostMessage(req, res);

  } catch (error) {
    logger.error('[MCP Message Error]', error);
    if (!res.headersSent) res.status(500).send("Internal MCP Error");
  }
};