import { Request, Response, NextFunction, Router } from 'express';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerSenzorTools } from '../../mcp/tools';
import { registerSenzorPrompts } from '../../mcp/prompts';
import { registerSenzorResources } from '../../mcp/resources';
import { logger } from '../../utils/logger';
import { authenticateMcp } from '../../middlewares/mcpAuth';
import { mcpRateLimiter } from '../../middlewares/mcpRateLimit';
export const mcpAgentRouter = Router();

// Server identity/metadata, shared by every transport.
const SERVER_INFO = {
  name: "Senzor MCP",
  version: "1.2.0",
  title: "Senzor",
  description: "Observability platform — APM, RUM, Logs, Uptime, Infrastructure, Firebase, Database (MongoDB/Redis/PostgreSQL/MySQL), Errors, Alerts & Incidents, Custom Dashboards, and Billing.",
  websiteUrl: "https://senzor.dev",
  icons: [{
    src: "https://senzor.dev/icons/icon512_maskable.png",
    mimeType: "image/png",
    sizes: ["512x512"],
  }],
};

/** Build a fresh MCP server instance bound to a single owner's data. */
const buildMcpServer = (ownerId: string): Server => {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {}, prompts: {}, resources: {} },
  });
  registerSenzorTools(server, ownerId);
  registerSenzorPrompts(server);
  registerSenzorResources(server, ownerId);
  return server;
};

// ===========================================================================
// PRIMARY TRANSPORT: Streamable HTTP (MCP spec 2025-03-26+)
// ---------------------------------------------------------------------------
// Runs in STATELESS mode: a fresh Server + transport is created per request and
// torn down when the response closes. No in-process session map, so the
// endpoint is horizontally scalable behind a load balancer (any instance can
// serve any request). All Senzor tools are stateless reads, so this is exact.
// The global express.json() parser has already consumed the body, so it is
// handed to the transport pre-parsed.
// ===========================================================================
const handleStreamable = async (req: Request, res: Response) => {
  const ownerId = (req as any).ownerId;
  const server = buildMcpServer(ownerId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    transport.close().catch(() => { });
    server.close().catch(() => { });
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req as any, res, (req as any).body);
  } catch (error) {
    logger.error('[MCP Streamable Error]', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal MCP error" },
        id: null,
      });
    }
  }
};

mcpAgentRouter.post('/', authenticateMcp, mcpRateLimiter, handleStreamable);
// GET (server->client notification stream) and DELETE (session teardown) are
// answered by the transport — in stateless mode it returns 405 for both, which
// is spec-compliant.
mcpAgentRouter.get('/', authenticateMcp, mcpRateLimiter, handleStreamable);
mcpAgentRouter.delete('/', authenticateMcp, mcpRateLimiter, handleStreamable);

// ===========================================================================
// DEPRECATED TRANSPORT: HTTP+SSE (MCP spec 2024-11-05)
// ---------------------------------------------------------------------------
// Retained only for clients already connected via /sse. New integrations should
// use the Streamable HTTP endpoint above. Sessions are held in-process, so this
// path is NOT multi-instance safe — acceptable for a deprecated shim.
// ===========================================================================
const activeSessions = new Map<string, { transport: SSEServerTransport, server: Server, ownerId: string }>();

// 1. AI Connects to SSE
mcpAgentRouter.get('/sse', authenticateMcp, mcpRateLimiter, async (req: Request, res: Response) => {
  try {
    const ownerId = (req as any).ownerId;
    const mcpServer = buildMcpServer(ownerId);

    const transport = new SSEServerTransport("/api/mcp/messages", res);
    await mcpServer.connect(transport);

    activeSessions.set(transport.sessionId, { transport, server: mcpServer, ownerId });
    logger.info(`[MCP] AI connected (SSE) for owner: ${ownerId} (Session: ${transport.sessionId})`);

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
mcpAgentRouter.post(['/messages', '/sse'], authenticateMcp, mcpRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
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
