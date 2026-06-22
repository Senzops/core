// src/worker/senzor-init.ts
import dotenv from 'dotenv';
import senzor from '@senzops/apm-node';

if (!process.env.MONGO_URI) {
  dotenv.config({ path: "src/config/.env" });
}

senzor.init({
  // Task/APM self-monitoring uses the task key; AI Monitoring (incident
  // analysis LLM usage) is routed to its own source via the dedicated AI key.
  apiKey: process.env.SENZOR_TASK_API_KEY!,
  ai: { apiKey: process.env.SENZOR_AI_API_KEY },
});