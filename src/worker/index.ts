import './senzor-init';
import mongoose from 'mongoose';
import { startUptimeWorker } from './uptime';
import { logger } from '../utils/logger';
import { startDatabaseWorker } from './database';
import { startWatchdogWorker } from './watchdog';
import { startDemoWorker } from './demo';
import { startAlertWatchdog } from './alertWatchdog';
import { startBillingCron } from './billing';
import { startFirebaseWorker } from './firebase';
import { startHeartbeatWorker } from './heartbeat';
import { startQueueWorkers } from './processors';
import { shutdownQueues } from '../lib/queue';
import { createAiAnalysisWorker } from '../lib/aiQueue';
import dotenv from 'dotenv';

if (!process.env.MONGO_URI) {
  dotenv.config({ path: "src/config/.env" });
}

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/senzor';

// Prevent uncaught exceptions and unhandled rejections from crashing the worker process.
// Each cron job runs independently — a single failure does not invalidate process state.
process.on('uncaughtException', (error) => {
  logger.error('[Worker] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason: any) => {
  logger.error('[Worker] Unhandled rejection:', reason);
});

// --- Standalone Worker Process ---
const initWorker = async () => {
  try {
    // 1. Connect to DB (Worker needs its own connection)
    await mongoose.connect(MONGO_URI);
    logger.info('[Worker] Connected to MongoDB');

    // 2. Start Logic
    startUptimeWorker();
    startDatabaseWorker();
    startWatchdogWorker();
    startDemoWorker(); // Demo worker
    startBillingCron();

    // Boot up the Alert Evaluation Engine
    startAlertWatchdog();

    // Firebase Monitoring
    startFirebaseWorker();

    // VPS Heartbeat Staleness Detection
    startHeartbeatWorker();

    // Ingestion Queue Workers (BullMQ)
    startQueueWorkers();

    // AI Incident Analysis Worker (BullMQ)
    createAiAnalysisWorker();
    logger.info('[Worker] AI Incident Analysis Worker started');

    // 3. Handle graceful shutdown
    process.on('SIGTERM', async () => {
      logger.info('[Worker] Shutting down...');
      await shutdownQueues();
      mongoose.connection.close();
      process.exit(0);
    });

  } catch (error) {
    logger.error('[Worker] Startup Error:', error);
    process.exit(1);
  }
};

initWorker();