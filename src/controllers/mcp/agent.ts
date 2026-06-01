import { Request, Response, NextFunction, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { registerSenzorTools } from '../../mcp/tools';
import { logger } from '../../utils/logger';
import { authenticateMcp } from '../../middlewares/mcpAuth';
export const mcpAgentRouter = Router();

const mcpLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: "Too many requests. AI agent must yield and summarize findings."
});

const activeSessions = new Map<string, { transport: SSEServerTransport, server: Server, ownerId: string }>();

// 1. AI Connects to SSE
mcpAgentRouter.get('/sse', authenticateMcp, async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).ownerId;
    const mcpServer = new Server({ name: "Senzor MCP", version: "1.0.0" }, { capabilities: { tools: {} } });

    registerSenzorTools(mcpServer, ownerId);

    const transport = new SSEServerTransport("/api/mcp/messages", res);
    await mcpServer.connect(transport);

    activeSessions.set(transport.sessionId, { transport, server: mcpServer, ownerId });
    logger.info(`[MCP] AI connected for owner: ${ownerId} (Session: ${transport.sessionId})`);

    res.on('close', () => {
      activeSessions.delete(transport.sessionId);
      mcpServer.close();
    });
  } catch (error) {
    logger.error('[MCP SSE Error]', error);
    if (!res.headersSent) res.status(500).json({ error: "Failed to establish MCP connection" });
  }
});

// 2. AI Posts Messages (Cursor quirk: POST to /sse, Official: POST to /messages)
mcpAgentRouter.post(['/messages', '/sse'], authenticateMcp, mcpLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    let mcpReq = req as any;

    // Reconstruct the exhausted raw stream from express.json()
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      const { Readable } = require('stream');
      mcpReq = Readable.from(Buffer.from(JSON.stringify(req.body)));
      mcpReq.query = req.query;
      mcpReq.method = req.method;
      mcpReq.url = req.url;
      mcpReq.headers = { ...req.headers };
      delete mcpReq.headers['content-length'];
    }

    const sessionId = req.query.sessionId as string;
    if (!sessionId) return res.status(400).send("Missing sessionId");

    const session = activeSessions.get(sessionId);
    if (!session) return res.status(404).send("MCP Session not found or expired");

    await session.transport.handlePostMessage(mcpReq, res);
  } catch (error) {
    logger.error('[MCP Message Error]', error);
    if (!res.headersSent) res.status(500).send("Internal MCP Error");
  }
});