import { OtlpContext } from '../../middlewares/otlpAuth';
import { LogEvent } from '../../models/Log';

const mapSeverity = (severityNumber: number): string => {
  if (!severityNumber) return 'info';
  if (severityNumber <= 8) return 'debug';
  if (severityNumber <= 12) return 'info';
  if (severityNumber <= 16) return 'warn';
  if (severityNumber <= 20) return 'error';
  return 'fatal';
};

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
    for (const sl of rl.scopeLogs || []) {
      for (const log of sl.logRecords || []) {
        const timestampMs = Number(log.timeUnixNano || log.observedTimeUnixNano) / 1000000;

        const attributes: any = {};
        if (log.attributes) {
          log.attributes.forEach((attr: any) => {
            attributes[attr.key] = extractValue(attr.value);
          });
        }

        logsToInsert.push({
          ownerId: context.ownerId,
          serviceId: context.serviceId,
          serviceModel: serviceModel,
          traceId: log.traceId,
          spanId: log.spanId,
          level: mapSeverity(log.severityNumber),
          message: extractValue(log.body) || 'Empty OTLP Log',
          attributes,
          timestamp: timestampMs > 0 ? new Date(timestampMs) : new Date()
        });
      }
    }
  }

  if (logsToInsert.length > 0) {
    await LogEvent.insertMany(logsToInsert, { ordered: false });
  }
};