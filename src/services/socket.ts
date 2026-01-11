import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import admin from 'firebase-admin';
import { Vps } from '../models/Vps';
import { logger } from '../utils/logger';

// Map to track active agents: vpsId -> socketId
const agentSockets = new Map<string, string>();

export const initSocketServer = (httpServer: HttpServer) => {
  const io = new Server(httpServer, {
    cors: {
      origin: true, // Allow frontend connections
      methods: ["GET", "POST"],
      credentials: true
    },
    path: '/api/socket', // Custom path to avoid conflicts
  });

  // --- Middleware: Hybrid Authentication ---
  io.use(async (socket, next) => {
    const { type } = socket.handshake.auth;

    try {
      // 1. Agent Authentication
      if (type === 'agent') {
        const { vpsId, apiKey } = socket.handshake.auth;
        const vps = await Vps.findOne({ _id: vpsId }).select('+apiKey');

        if (!vps || vps.apiKey !== apiKey) {
          return next(new Error('Invalid Agent Credentials'));
        }

        // Tag socket for easy access
        socket.data.vpsId = vpsId;
        socket.data.role = 'agent';
        return next();
      }

      // 2. User (Frontend) Authentication
      if (type === 'client') {
        const { token } = socket.handshake.auth;
        if (!token) return next(new Error('Missing Auth Token'));

        const decodedToken = await admin.auth().verifyIdToken(token);
        socket.data.uid = decodedToken.uid;
        socket.data.role = 'client';
        return next();
      }

      return next(new Error('Unknown Connection Type'));

    } catch (err) {
      logger.error('Socket Auth Error', err);
      return next(new Error('Authentication Failed'));
    }
  });

  // --- Connection Handler ---
  io.on('connection', (socket) => {
    if (socket.data.role === 'agent') {
      handleAgentConnection(socket);
    } else {
      handleClientConnection(socket);
    }
  });

  return io;
};

// --- Agent Logic ---
const handleAgentConnection = (socket: Socket) => {
  const vpsId = socket.data.vpsId;
  agentSockets.set(vpsId, socket.id);
  logger.info(`[Socket] Agent connected: ${vpsId}`);

  socket.join(`vps:${vpsId}`); // Agent joins its own room

  socket.on('disconnect', () => {
    agentSockets.delete(vpsId);
    logger.info(`[Socket] Agent disconnected: ${vpsId}`);
  });

  // Forward PTY output from Agent to Frontend
  socket.on('term:output', (data) => {
    // Broadcast to everyone in this VPS room (which includes the User)
    // We exclude the sender (agent) automatically
    socket.to(`vps:${vpsId}`).emit('term:output', data);
  });
};

// --- Client (User) Logic ---
const handleClientConnection = (socket: Socket) => {
  logger.info(`[Socket] User connected: ${socket.data.uid}`);

  // User requests to connect to a specific VPS Terminal
  socket.on('term:connect', async ({ vpsId }) => {
    // 1. Verify Ownership
    const vps = await Vps.findOne({ _id: vpsId, ownerId: socket.data.uid });
    if (!vps) {
      socket.emit('term:error', 'Access Denied or VPS not found');
      return;
    }

    // 2. Check if Agent is online
    if (!agentSockets.has(vpsId)) {
      socket.emit('term:error', 'Agent is offline');
      return;
    }

    // 3. Join the secure room
    socket.join(`vps:${vpsId}`);

    // 4. Signal Agent to spawn shell
    const agentSocketId = agentSockets.get(vpsId);
    if (agentSocketId) {
      socket.to(agentSocketId).emit('term:spawn', { cols: 80, rows: 24 });
    }

    logger.info(`[Socket] User ${socket.data.uid} joined terminal ${vpsId}`);
  });

  // Forward input from User -> Agent
  socket.on('term:input', ({ vpsId, data }) => {
    // Security: User must be in the room to send
    if (socket.rooms.has(`vps:${vpsId}`)) {
      const agentSocketId = agentSockets.get(vpsId);
      if (agentSocketId) {
        socket.to(agentSocketId).emit('term:input', data);
      }
    }
  });

  socket.on('term:resize', ({ vpsId, cols, rows }) => {
    if (socket.rooms.has(`vps:${vpsId}`)) {
      const agentSocketId = agentSockets.get(vpsId);
      if (agentSocketId) {
        socket.to(agentSocketId).emit('term:resize', { cols, rows });
      }
    }
  });
};