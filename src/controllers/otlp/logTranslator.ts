import { OtlpContext } from '../../middlewares/otlpAuth';
import { LogEvent } from '../../models/Log';
import { normalizeSeverity } from '../../utils/severity';
import { recordIngestStat } from '../../services/logIngestStats';
import { getRetentionMs, stampExpiry } from '../../services/retentionCache';

const extractValue = (valueObj: any): any => {
  if (!valueObj) return undefined;
  if (valueObj.stringValue !== undefined) return valueObj.stringValue;
  if (valueObj.intValue !== undefined) return valueObj.intValue;
  if (valueObj.doubleValue !== undefined) return valueObj.doubleValue;
  if (valueObj.boolValue !== undefined) return valueObj.boolValue;
  if (valueObj.arrayValue !== undefined) return valueObj.arrayValue.values?.map(extractValue);
  if (valueObj.kvlistValue !== undefined) {
    const obj: any = {};
    valueObj.kvlistValue.values?.forEach((kv: any) => {
      obj[kv.key] = extractValue(kv.value);
    });
    return obj;
  }
  return JSON.stringify(valueObj);
};

export const translateOtlpLogs = async (context: OtlpContext, resourceLogs: any[]) => {
  const logsToInsert: any[] = [];

  const serviceModel = context.target === 'task' ? 'TaskService' : context.target === 'rum' ? 'RumService' : 'ApmService';

  for (const rl of resourceLogs) {
    // Resource-level attributes describe the emitting host/service/environment
    // and apply to every log record under this resource.
    const resourceAttrs: any = {};
    if (rl.resource?.attributes) {
      rl.resource.attributes.forEach((attr: any) => {
        resourceAttrs[attr.key] = extractValue(attr.value);
      });
    }
    const host = resourceAttrs['host.name'] ?? resourceAttrs['host.id'] ?? undefined;
    const environment = resourceAttrs['deployment.environment.name']
      ?? resourceAttrs['deployment.environment'] ?? undefined;

    for (const sl of rl.scopeLogs || []) {
      for (const log of sl.logRecords || []) {
        const timestampMs = Number(log.timeUnixNano || log.observedTimeUnixNano) / 1000000;

        const attributes: any = {};
        if (log.attributes) {
          log.attributes.forEach((attr: any) => {
            attributes[attr.key] = extractValue(attr.value);
          });
        }

        const sev = normalizeSeverity({
          severityNumber: log.severityNumber,
          severityText: log.severityText,
        });

        logsToInsert.push({
          ownerId: context.ownerId,
          serviceId: context.serviceId,
          serviceModel: serviceModel,
          traceId: log.traceId,
          spanId: log.spanId,
          level: sev.level,
          severityText: sev.severityText,
          severityNumber: sev.severityNumber,
          // Source = the originating service name so logs show which service they belong to.
          source: context.serviceName || 'otlp',
          host: typeof host === 'string' ? host : undefined,
          environment: typeof environment === 'string' ? environment : undefined,
          message: extractValue(log.body) || 'Empty OTLP Log',
          attributes,
          timestamp: timestampMs > 0 ? new Date(timestampMs) : new Date()
        });
      }
    }
  }

  if (logsToInsert.length > 0) {
    // anchor: timestamp (the log's event time)
    stampExpiry(logsToInsert, 'timestamp', await getRetentionMs(context.ownerId));
    try {
      const result = await LogEvent.insertMany(logsToInsert, { ordered: false });
      recordIngestStat(context.ownerId, result.length, logsToInsert.length - result.length);
    } catch (err: any) {
      if (err.name === 'BulkWriteError' || err.code === 11000 || err.writeErrors) {
        const inserted = err.result?.insertedCount ?? err.insertedDocs?.length ?? 0;
        recordIngestStat(context.ownerId, inserted, logsToInsert.length - inserted);
      } else {
        throw err;
      }
    }
  }
};