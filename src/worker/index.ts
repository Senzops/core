import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { startUptimeWorker } from './uptime';
import { logger } from '../utils/logger';
import { startDatabaseWorker } from './database';
import senzor from '@senzops/apm-node';

if (!process.env.MONGO_URI) {
  dotenv.config({ path: "src/config/.env" });
}

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/senzor';
const SENZOR_TASK_API_KEY: string = process.env.SENZOR_TASK_API_KEY!;
senzor.init({
  apiKey: SENZOR_TASK_API_KEY,
  debug: true,
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

    // 3. Handle graceful shutdown
    process.on('SIGTERM', () => {
      logger.info('[Worker] Shutting down...');
      mongoose.connection.close();
      process.exit(0);
    });

  } catch (error) {
    logger.error('[Worker] Startup Error:', error);
    process.exit(1);
  }
};

initWorker();