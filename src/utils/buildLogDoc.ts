import { normalizeSeverity } from './severity';

// ============================================================================
// Service Log Document Builder
// ----------------------------------------------------------------------------
// Single source of truth for turning a service-emitted log payload (from the
// native APM / RUM / Task batch ingest endpoints) into a LogEvent document.
//
// Centralizing this prevents field drift: every service log gets canonical
// severity (severityText/severityNumber), a meaningful `source` (the service
// name, so it is displayed AND queryable), and bounded message size — without
// each ingest path having to remember to set them.
// ============================================================================

const MAX_MESSAGE = 50_000;

export interface ServiceLogContext {
  ownerId: any;
  serviceId?: any;
  serviceModel: 'ApmService' | 'RumService' | 'TaskService';
  /** Originating service name — stored as `source` for display + querying. */
  source?: string;
}

export function buildServiceLogDoc(log: any, ctx: ServiceLogContext) {
  const sev = normalizeSeverity({ level: log?.level, severity: log?.severity, severityNumber: log?.severityNumber });

  const rawMsg = log?.message;
  const message = typeof rawMsg === 'string'
    ? (rawMsg.length > MAX_MESSAGE ? rawMsg.slice(0, MAX_MESSAGE) + '... [TRUNCATED]' : rawMsg) || 'Empty Log'
    : 'Empty Log';

  return {
    ownerId: ctx.ownerId,
    serviceId: ctx.serviceId,
    serviceModel: ctx.serviceModel,
    traceId: log?.traceId ? String(log.traceId) : undefined,
    spanId: log?.spanId ? String(log.spanId) : undefined,
    level: sev.level,
    severityText: sev.severityText,
    severityNumber: sev.severityNumber,
    source: (typeof ctx.source === 'string' && ctx.source.trim()) ? ctx.source.trim() : undefined,
    host: typeof log?.host === 'string' ? log.host : (typeof log?.hostname === 'string' ? log.hostname : undefined),
    environment: typeof log?.environment === 'string' ? log.environment : (typeof log?.env === 'string' ? log.env : undefined),
    message,
    attributes: log?.attributes || {},
    timestamp: log?.timestamp ? new Date(log.timestamp) : new Date(),
  };
}
