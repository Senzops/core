// src/worker/senzor-init.ts
import dotenv from 'dotenv';

if (!process.env.MONGO_URI) {
  dotenv.config({ path: "src/config/.env" });
}

// tracing.ts — run with: node --import ./tracing.ts app.ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";

const SENZOR_APM_API_KEY: string = process.env.SENZOR_APM_API_KEY!;

process.on("uncaughtException", (error) => {
  console.error(error);
});

process.on("unhandledRejection", (reason) => {
  console.error(reason);
});

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: "https://api.senzor.dev/api/otlp/v1/traces",
    headers: { Authorization: `Bearer ${SENZOR_APM_API_KEY}` },
  }),
  logRecordProcessors: [
    new SimpleLogRecordProcessor(
      new OTLPLogExporter({
        url: "https://api.senzor.dev/api/otlp/v1/logs",
        headers: { Authorization: `Bearer ${SENZOR_APM_API_KEY}` },
      })
    ),
  ],
  instrumentations: [
    getNodeAutoInstrumentations({
      // BullMQ uses ioredis internally for lock management, job state transitions,
      // and Lua script execution. OTel's ioredis instrumentation wraps every Redis
      // command in async span context, which interferes with BullMQ's lock renewal
      // timers — causing lock mismatch errors (code -6) on moveToFinished.
      '@opentelemetry/instrumentation-ioredis': { enabled: false },
    }),
  ],
});

sdk.start();