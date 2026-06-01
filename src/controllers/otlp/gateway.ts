import { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger';
import { translateOtlpTraces } from './traceTranslator';
import { translateOtlpLogs } from './logTranslator';
import { ApmService } from '../../models/Apm';
import { RumService } from '../../models/Rum';
import { TaskService } from '../../models/Task';
import { OtlpContext } from '../../middlewares/otlpAuth';
import { getClientIp } from '../../utils/getClientIp';

// --- Enterprise Fix: Centralized Async Heartbeat ---
// Updates the service's lastSeen timestamp without blocking the high-throughput OTLP pipeline.
const updateLastSeen = async (context: OtlpContext) => {
  const now = new Date();
  try {
    if (context.target === 'apm') {
      await ApmService.findByIdAndUpdate(context.serviceId, { lastSeen: now });
    } else if (context.target === 'rum') {
      await RumService.findByIdAndUpdate(context.serviceId, { lastSeen: now });
    } else if (context.target === 'task') {
      await TaskService.findByIdAndUpdate(context.serviceId, { lastSeen: now });
    }
  } catch (error: any) {
    logger.error(`[OTLP Gateway] Failed to update lastSeen for ${context.serviceName}: ${error.message}`);
  }
};

/**
 * Handles incoming OpenTelemetry Trace Data (ResourceSpans)
 * Standard OTLP Endpoint: POST /v1/traces
 */
export const ingestOtlpTraces = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const context = req.otlpContext!;
    const { resourceSpans } = req.body;

    if (!resourceSpans || !Array.isArray(resourceSpans)) {
      return res.status(400).json({ error: "Invalid OTLP payload: Missing resourceSpans array" });
    }

    const requestIp = getClientIp(req);
    const requestUserAgent = req.headers['user-agent'] || undefined;

    // Acknowledge receipt immediately to free up the client SDK (Standard OTel behavior)
    res.status(202).json({ message: "Traces accepted for processing" });

    // Offload the heavy translation and MongoDB upserts to the background engine
    translateOtlpTraces(context, resourceSpans, requestIp, requestUserAgent).catch(err => {
      logger.error(`[OTLP Traces] Translation failed for ${context.serviceName}: ${err.message}`);
    });

    // Fire the heartbeat updater
    updateLastSeen(context);

    logger.info(`[OTLP Gateway] Accepted Trace payload from ${context.target} service: ${context.serviceName}`);

  } catch (error: any) {
    logger.error(`[OTLP Gateway] Trace ingestion error: ${error.message}`);
    // Only send 500 if we haven't already sent the 202 Accepted
    if (!res.headersSent) res.status(500).json({ error: "Trace ingestion failed" });
  }
};

/**
 * Handles incoming OpenTelemetry Log Data (ResourceLogs)
 * Standard OTLP Endpoint: POST /v1/logs
 */
export const ingestOtlpLogs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const context = req.otlpContext!;
    const { resourceLogs } = req.body;

    if (!resourceLogs || !Array.isArray(resourceLogs)) {
      return res.status(400).json({ error: "Invalid OTLP payload: Missing resourceLogs array" });
    }

    // Acknowledge receipt immediately
    res.status(202).json({ message: "Logs accepted for processing" });

    // Offload translation and ingestion to the background engine
    translateOtlpLogs(context, resourceLogs).catch(err => {
      logger.error(`[OTLP Logs] Translation failed for ${context.serviceName}: ${err.message}`);
    });

    // Fire the heartbeat updater
    updateLastSeen(context);

    logger.info(`[OTLP Gateway] Accepted Logs payload from ${context.target} service: ${context.serviceName}`);

  } catch (error: any) {
    logger.error(`[OTLP Gateway] Log ingestion error: ${error.message}`);
    if (!res.headersSent) res.status(500).json({ error: "Log ingestion failed" });
  }
};
