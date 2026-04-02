import { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger';
import { translateOtlpTraces } from './traceTranslator';
import { translateOtlpLogs } from './logTranslator';

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

    // Acknowledge receipt immediately to free up the client SDK (Standard OTel behavior)
    res.status(202).json({ message: "Traces accepted for processing" });

    // Offload the heavy translation and MongoDB upserts to the background engine
    translateOtlpTraces(context, resourceSpans).catch(err => {
      logger.error(`[OTLP Traces] Translation failed for ${context.serviceName}: ${err.message}`);
    });

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

    logger.info(`[OTLP Gateway] Accepted Logs payload from ${context.target} service: ${context.serviceName}`);

  } catch (error: any) {
    logger.error(`[OTLP Gateway] Log ingestion error: ${error.message}`);
    if (!res.headersSent) res.status(500).json({ error: "Log ingestion failed" });
  }
};