// src/worker/senzor-init.ts
import dotenv from 'dotenv';
import senzor from '@senzops/apm-node';

if (!process.env.MONGO_URI) {
  dotenv.config({ path: "src/config/.env" });
}

senzor.init({
  apiKey: process.env.SENZOR_TASK_API_KEY!,
  // Exclude redis and bullmq from auto-instrumentation in the worker process.
  // The SDK's redis/bullmq wrappers add async context around ioredis commands,
  // which interferes with BullMQ's internal lock renewal timers — causing
  // lock mismatch errors (code -6) when jobs finish processing.
  instrumentations: [
    'http', 'express', 'mongo', 'mongoose', 'pg', 'mysql',
    'cron', 'dns', 'net', 'winston', 'fs',
  ],
});