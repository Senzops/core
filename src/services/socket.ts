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
      origin: true,
      methods: ["GET", "POST"],
      credentials: true
    },
    path: '/api/socket',
  });

  // --- Middleware ---
  io.use(async (socket, next) => {
    const { type } = socket.handshake.auth;

    try {
      // 1. Agent Auth
      if (type === 'agent') {
        const { vpsId, apiKey } = socket.handshake.auth;
        const vps = await Vps.findOne({ _id: vpsId }).select('+apiKey');

        if (!vps || vps.apiKey !== apiKey) return next(new Error('Invalid Agent Credentials'));

        socket.data.vpsId = vpsId;
        socket.data.role = 'agent';
        return next();
      }

      // 2. Client Auth
      if (type === 'client') {
        const { token } = socket.handshake.auth;
        if (!token) return next(new Error('Missing Auth Token'));

        // Handle Demo Token
        if (token === 'demo-token') {
          socket.data.uid = 'demo-user';
          socket.data.role = 'client';
          socket.data.isDemo = true;
          return next();
        }

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

  io.on('connection', (socket) => {
    if (socket.data.role === 'agent') {
      handleAgentConnection(socket);
    } else {
      handleClientConnection(socket, io);
    }
  });

  return io;
};

// --- Agent Logic ---
const handleAgentConnection = (socket: Socket) => {
  const vpsId = socket.data.vpsId;
  agentSockets.set(vpsId, socket.id);
  logger.info(`[Socket] Agent connected: ${vpsId}`);

  socket.join(`vps:${vpsId}`);

  socket.on('disconnect', () => {
    agentSockets.delete(vpsId);
    logger.info(`[Socket] Agent disconnected: ${vpsId}`);
  });

  socket.on('term:output', (data) => {
    socket.to(`vps:${vpsId}`).emit('term:output', data);
  });
};

// --- Client Logic ---
const handleClientConnection = (socket: Socket, io: Server) => {
  // Track which VPS this user is currently viewing to handle cleanup
  let currentVpsId: string | null = null;

  socket.on('term:connect', async ({ vpsId }) => {
    // 1. Verify Access (Skip DB check for Demo, or mock it)
    if (!socket.data.isDemo) {
      const vps = await Vps.findOne({ _id: vpsId, ownerId: socket.data.uid });
      if (!vps) {
        socket.emit('term:error', 'Access Denied');
        return;
      }
    }

    if (!agentSockets.has(vpsId)) {
      socket.emit('term:error', 'Agent is offline');
      return;
    }

    // 2. Join Room
    socket.join(`vps:${vpsId}`);
    currentVpsId = vpsId;

    // 3. Trigger Spawn
    // We send this to the specific agent socket ID to be safe
    const agentSocketId = agentSockets.get(vpsId);
    if (agentSocketId) {
      io.to(agentSocketId).emit('term:spawn', { cols: 80, rows: 24 });
    }

    logger.info(`[Socket] User ${socket.data.uid} joined terminal ${vpsId}`);
  });

  socket.on('term:input', ({ vpsId, data }) => {
    if (socket.rooms.has(`vps:${vpsId}`)) {
      const agentSocketId = agentSockets.get(vpsId);
      if (agentSocketId) io.to(agentSocketId).emit('term:input', data);
    }
  });

  socket.on('term:resize', ({ vpsId, cols, rows }) => {
    if (socket.rooms.has(`vps:${vpsId}`)) {
      const agentSocketId = agentSockets.get(vpsId);
      if (agentSocketId) io.to(agentSocketId).emit('term:resize', { cols, rows });
    }
  });

  // --- CLEANUP ON DISCONNECT ---
  socket.on('disconnect', () => {
    if (currentVpsId) {
      // Check if anyone else is left in the room
      // The room Set contains socket IDs. 
      // If the Agent is in the room, size might be 1 (Agent) or 0 if Agent left too.
      // We essentially want to know if any *Clients* are left.

      const room = io.sockets.adapter.rooms.get(`vps:${currentVpsId}`);

      // Filter out the Agent's own socket ID from the count
      const agentSocketId = agentSockets.get(currentVpsId);
      let userCount = 0;

      if (room) {
        room.forEach(id => {
          if (id !== agentSocketId) userCount++;
        });
      }

      // If no users left, tell Agent to kill the PTY
      if (userCount === 0 && agentSocketId) {
        logger.info(`[Socket] Room vps:${currentVpsId} empty. Killing PTY.`);
        io.to(agentSocketId).emit('term:destroy');
      }
    }
  });
};