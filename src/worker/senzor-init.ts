// src/worker/senzor-init.ts
import dotenv from 'dotenv';
import senzor from '@senzops/apm-node';

if (!process.env.MONGO_URI) {
  dotenv.config({ path: "src/config/.env" });
}

senzor.init({
  apiKey: process.env.SENZOR_TASK_API_KEY!,
  debug: true,
});