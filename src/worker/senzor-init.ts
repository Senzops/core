// src/worker/senzor-init.ts
import dotenv from 'dotenv';
import senzor from '@senzops/apm-node';

// Load local .env to fill any vars the platform hasn't already provided.
// dotenv never overrides existing process.env, so this is safe in production
// (platform-injected vars always win) and — unlike a `!process.env.MONGO_URI`
// guard — it guarantees the self-monitoring keys are loaded even when MONGO_URI
// comes from the platform but the SDK keys live in the .env file.
if (!process.env.MONGO_URI) {
  dotenv.config({ path: "src/config/.env" });
}

const taskKey = process.env.SENZOR_TASK_API_KEY;
const aiKey = process.env.SENZOR_AI_API_KEY;
// Optional override for self-hosted / non-prod (e.g. http://localhost:5000/api).
// Defaults to the SDK's public ingest endpoint.
const endpoint = process.env.SENZOR_INGEST_ENDPOINT;
// Opt-in: send masked prompts / outputs / tool args for our OWN incident-analysis
// to AI Monitoring (off by default — content never leaves the process unless set).
// The AI source ALSO needs "Capture prompts & outputs" enabled (server-side gate).
const captureContent = process.env.SENZOR_AI_CAPTURE_CONTENT === 'true';

senzor.init({
  // Task/APM self-monitoring uses the task key; AI Monitoring (incident-analysis
  // LLM usage) is routed to its own source via the dedicated AI key.
  apiKey: taskKey || '',
  ai: { apiKey: aiKey, captureContent },
  ...(endpoint ? { endpoint } : {}),
});

// Surface AI self-monitoring status so a missing key never fails silently.
if (aiKey) {
  console.log(`[Senzor] AI self-monitoring enabled (ingest: ${endpoint || 'default'}).`);
} else {
  console.warn(
    '[Senzor] SENZOR_AI_API_KEY is not set — backend AI/LLM usage (incident analysis) will NOT be recorded in AI Monitoring.',
  );
}
