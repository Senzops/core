import { OtlpContext } from '../../middlewares/otlpAuth';
import { ApmTrace, ApmMetric } from '../../models/Apm';
import { TaskRun, TaskMetric } from '../../models/Task';
import { RumTrace } from '../../models/Rum';
import { ErrorGroup, ErrorEvent, generateErrorFingerprint } from '../../models/Error';
import { UAParser } from 'ua-parser-js';
import { normaliseIP } from '../../utils/getClientIp';
import { getGeoData } from '../../utils/getGeoData';
import { getRetentionMs, stampExpiry } from '../../services/retentionCache';

/**
 * Stamps plan-based `expiresAt` onto a set of upsert bulk ops. The expiry is
 * anchored on the doc's `timestamp` (carried in $set or $setOnInsert) and added
 * to the same operator so the upsert never sets the field twice. Inserts get a
 * fixed expiry at creation; documents that only ever update keep their original.
 */
const stampTraceOpsExpiry = (ops: any[], retentionMs: number): void => {
  for (const op of ops) {
    const update = op?.updateOne?.update;
    if (!update) continue;
    const soi = update.$setOnInsert;
    const set = update.$set;
    const holder = soi && soi.timestamp ? soi : set && set.timestamp ? set : null;
    const anchorMs = holder?.timestamp ? new Date(holder.timestamp).getTime() : Date.now();
    const expiresAt = new Date(anchorMs + retentionMs);
    if (soi) soi.expiresAt = expiresAt;
    else if (set) set.expiresAt = expiresAt;
    else update.$set = { expiresAt };
  }
};

// ---------------------------------------------------------------------------
// OTel Attribute Helpers
// ---------------------------------------------------------------------------

const MAX_SPAN_META_KEYS = 50;

const extractValue = (valueObj: any): any => {
  if (!valueObj) return undefined;
  if (valueObj.stringValue !== undefined) return valueObj.stringValue;
  if (valueObj.intValue !== undefined) return valueObj.intValue;
  if (valueObj.doubleValue !== undefined) return valueObj.doubleValue;
  if (valueObj.boolValue !== undefined) return valueObj.boolValue;
  if (valueObj.arrayValue?.values) return valueObj.arrayValue.values.map(extractValue);
  if (valueObj.kvlistValue?.values) {
    const obj: Record<string, any> = {};
    for (const kv of valueObj.kvlistValue.values) {
      obj[kv.key] = extractValue(kv.value);
    }
    return obj;
  }
  return undefined;
};

const getAttribute = (attributes: any[], key: string): any => {
  const attr = attributes?.find((a: any) => a.key === key);
  if (!attr?.value) return undefined;
  return extractValue(attr.value);
};

const collectAttributes = (attributes: any[]): Record<string, any> => {
  if (!attributes?.length) return {};
  const result: Record<string, any> = {};
  let count = 0;
  for (const attr of attributes) {
    if (count >= MAX_SPAN_META_KEYS) break;
    const val = extractValue(attr.value);
    if (val !== undefined && val !== null && val !== '') {
      result[attr.key] = val;
      count++;
    }
  }
  return result;
};

const cleanMessageForFingerprint = (message: string): string => {
  return message
    .replace(/[0-9a-fA-F]{24}/g, '<id>')
    .replace(/\b[0-9a-f]{8}\b-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-\b[0-9a-f]{12}\b/ig, '<uuid>')
    .replace(/\d+/g, '<num>');
};

// ---------------------------------------------------------------------------
// IP / Geo / User-Agent Extraction
// ---------------------------------------------------------------------------

const extractClientIp = (attributes: any[], resourceAttrs: any[], requestIp: string | null): string | null => {
  const raw =
    getAttribute(attributes, 'http.client_ip') ||
    getAttribute(attributes, 'net.sock.peer.addr') ||
    getAttribute(attributes, 'net.peer.ip') ||
    getAttribute(resourceAttrs, 'net.host.ip');

  if (raw) {
    const ip = normaliseIP(String(raw));
    if (ip) return ip;
  }

  return requestIp ? normaliseIP(requestIp) : null;
};

const extractUserAgent = (attributes: any[], resourceAttrs: any[], requestUserAgent?: string): string => {
  return (
    getAttribute(attributes, 'user_agent.original') ||
    getAttribute(attributes, 'http.user_agent') ||
    getAttribute(resourceAttrs, 'user_agent.original') ||
    requestUserAgent ||
    ''
  );
};

const parseUserAgent = (ua: string) => {
  if (!ua) return { browser: 'Unknown', os: 'Unknown', device: 'Desktop' };
  const parser = new UAParser(ua);
  return {
    browser: parser.getBrowser().name || 'Unknown',
    os: parser.getOS().name || 'Unknown',
    device: parser.getDevice().type || 'Desktop',
  };
};

// ---------------------------------------------------------------------------
// Metric Increment Helpers (mirrors native APM ingest)
// ---------------------------------------------------------------------------

const inc = (obj: Record<string, number>, key: string) => {
  const safeKey = key.replace(/\./g, '_').replace(/\$/g, '');
  obj[safeKey] = (obj[safeKey] || 0) + 1;
};

const incRoute = (obj: Record<string, any>, key: string, isError: boolean, duration: number) => {
  const safeKey = key.replace(/\./g, '_').replace(/\$/g, '');
  if (!obj[safeKey]) obj[safeKey] = { count: 0, errors: 0, duration: 0 };
  obj[safeKey].count += 1;
  if (isError) obj[safeKey].errors += 1;
  obj[safeKey].duration += duration;
};

// ---------------------------------------------------------------------------
// Main Translator
// ---------------------------------------------------------------------------

export const translateOtlpTraces = async (
  context: OtlpContext,
  resourceSpans: any[],
  requestIp: string | null,
  requestUserAgent?: string
) => {
  const apmTraceOps: any[] = [];
  const taskRunOps: any[] = [];
  const rumTraceOps: any[] = [];

  const apmMetricsMap = new Map<string, any>();
  const taskMetricsMap = new Map<string, any>();

  const errorEvents: any[] = [];
  const errorGroupsMap = new Map<string, any>();

  for (const rs of resourceSpans) {
    const resourceAttrs = rs.resource?.attributes || [];

    for (const ss of rs.scopeSpans || []) {
      for (const span of ss.spans || []) {
        const spanId = span.spanId;
        const traceId = span.traceId;
        const parentSpanId = span.parentSpanId;
        const kind = span.kind; // 1: INTERNAL, 2: SERVER, 3: CLIENT, 4: PRODUCER, 5: CONSUMER
        const name = span.name || 'Unknown Operation';

        // Convert Unix Nano to Milliseconds with safe fallback guarantees
        const startTimeMs = span.startTimeUnixNano ? Number(span.startTimeUnixNano) / 1000000 : Date.now();
        const endTimeMs = span.endTimeUnixNano ? Number(span.endTimeUnixNano) / 1000000 : startTimeMs;
        const duration = Math.max(0, endTimeMs - startTimeMs);
        const timestamp = new Date(startTimeMs);

        const attributes = span.attributes || [];

        // Extract Standard OTel Conventions
        const httpMethod = getAttribute(attributes, 'http.method') || getAttribute(attributes, 'http.request.method');
        const httpRoute = getAttribute(attributes, 'http.route');
        const httpUrl = getAttribute(attributes, 'url.full') || getAttribute(attributes, 'http.url');
        const httpTarget = getAttribute(attributes, 'url.path') || getAttribute(attributes, 'http.target');
        const httpStatusCode = getAttribute(attributes, 'http.response.status_code') || getAttribute(attributes, 'http.status_code');

        const dbSystem = getAttribute(attributes, 'db.system');

        const errorMsg = getAttribute(attributes, 'error.message') || getAttribute(attributes, 'exception.message');
        const errorType = getAttribute(attributes, 'error.type') || getAttribute(attributes, 'exception.type');
        const errorStack = getAttribute(attributes, 'exception.stacktrace');

        // Status logic (OTel Code 2 = ERROR)
        const isError = span.status?.code === 2;
        const spanStatus = isError ? (httpStatusCode || 500) : (httpStatusCode || 200);

        // Heuristic: Is this an entry point (Root Span) for this specific microservice?
        const isRoot = kind === 2 || kind === 5; // SERVER or CONSUMER

        if (isRoot) {
          // -----------------------------------------------------------------
          // 1. ROOT SPAN REGISTRATION
          // -----------------------------------------------------------------
          if (context.target === 'apm') {
            const route = httpRoute || httpTarget || name || 'Unknown Route';
            const path = httpTarget || httpUrl || name || 'Unknown Path';
            const method = httpMethod || 'INTERNAL';

            // --- IP / Geo / UA extraction (parity with native APM ingest) ---
            const ip = extractClientIp(attributes, resourceAttrs, requestIp);
            const { country, city } = getGeoData(ip);
            const userAgent = extractUserAgent(attributes, resourceAttrs, requestUserAgent);
            const { browser, os, device } = parseUserAgent(userAgent);

            apmTraceOps.push({
              updateOne: {
                filter: { traceId, serviceId: context.serviceId },
                update: {
                  $set: {
                    serviceId: context.serviceId, traceId,
                    parentSpanId,
                    method, route, path, status: spanStatus, duration, timestamp,
                    hasErrors: isError,
                    ip: ip ?? 'Unknown',
                    country, city,
                    userAgent: userAgent || 'Unknown',
                    browser, os, device,
                  }
                },
                upsert: true
              }
            });

            // --- Aggregate APM Metrics (full dimension parity) ---
            const bucketTime = new Date(timestamp);
            bucketTime.setSeconds(0, 0);
            const bucketKey = bucketTime.toISOString();

            if (!apmMetricsMap.has(bucketKey)) {
              apmMetricsMap.set(bucketKey, {
                timestamp: bucketTime,
                requests: 0, errorCount: 0, durationSum: 0, durationMax: 0,
                routes: {}, statusCodes: {},
                countries: {}, browsers: {}, os: {}, devices: {},
              });
            }
            const m = apmMetricsMap.get(bucketKey);
            m.requests++;
            if (isError) m.errorCount++;
            m.durationSum += duration;
            if (duration > m.durationMax) m.durationMax = duration;

            incRoute(m.routes, `${method} ${route}`, isError, duration);
            inc(m.statusCodes, String(spanStatus));
            inc(m.countries, country);
            inc(m.browsers, browser);
            inc(m.os, os);
            inc(m.devices, device);

          } else if (context.target === 'task') {
            const taskName = name;

            taskRunOps.push({
              updateOne: {
                filter: { runId: traceId, serviceId: context.serviceId },
                update: {
                  $set: {
                    serviceId: context.serviceId, runId: traceId, taskName,
                    taskType: 'custom', status: isError ? 'failed' : 'success', duration, timestamp,
                    metadata: { source: 'opentelemetry' }
                  }
                },
                upsert: true
              }
            });

            // Aggregate Task Metrics
            const bucketTime = new Date(timestamp);
            bucketTime.setSeconds(0, 0);
            const bucketKey = `${taskName}_${bucketTime.toISOString()}`;
            if (!taskMetricsMap.has(bucketKey)) {
              taskMetricsMap.set(bucketKey, { taskName, timestamp: bucketTime, runs: 0, failures: 0, durationSum: 0, durationMax: 0 });
            }
            const m = taskMetricsMap.get(bucketKey);
            m.runs++;
            if (isError) m.failures++;
            m.durationSum += duration;
            if (duration > m.durationMax) m.durationMax = duration;

          } else if (context.target === 'rum') {
            // --- RUM: extract browser/OS/device from resource/span attributes ---
            const ip = extractClientIp(attributes, resourceAttrs, requestIp);
            const { country, city } = getGeoData(ip);
            const userAgent = extractUserAgent(attributes, resourceAttrs, requestUserAgent);
            const { browser, os, device } = parseUserAgent(userAgent);

            rumTraceOps.push({
              updateOne: {
                filter: { traceId, serviceId: context.serviceId },
                update: {
                  $set: {
                    serviceId: context.serviceId, traceId,
                    sessionId: getAttribute(attributes, 'session.id') || getAttribute(resourceAttrs, 'session.id') || 'unknown',
                    traceType: 'route_change', url: httpUrl || 'unknown',
                    path: httpTarget || name || 'Unknown Path',
                    duration, timestamp,
                    ip: ip ?? 'Unknown',
                    country, city,
                    userAgent: userAgent || 'Unknown',
                    browser, os, device,
                  }
                },
                upsert: true
              }
            });
          }

        } else {
          // -----------------------------------------------------------------
          // 2. CHILD SPAN REGISTRATION
          // -----------------------------------------------------------------
          const type = dbSystem ? 'db' : (httpMethod ? 'http' : 'custom');

          const spanMeta = collectAttributes(attributes);

          const childSpan = {
            spanId, parentSpanId, name, type,
            // Storing absolute MS. Read controllers will dynamically map to relative MS for the Waterfall UI.
            startTime: startTimeMs,
            duration, status: spanStatus,
            meta: spanMeta
          };

          // Partial Trace Protection
          if (context.target === 'apm') {
            apmTraceOps.push({
              updateOne: {
                filter: { traceId, serviceId: context.serviceId },
                update: {
                  $push: { spans: childSpan },
                  $setOnInsert: {
                    timestamp,
                    duration: 0,
                    method: 'INTERNAL',
                    route: name || 'Internal Operation',
                    path: name || 'Internal Operation',
                    status: 200,
                    hasErrors: isError,
                    ip: 'Unknown', country: 'Unknown', city: 'Unknown',
                    userAgent: 'Unknown', browser: 'Unknown', os: 'Unknown', device: 'Desktop',
                  }
                },
                upsert: true
              }
            });
          } else if (context.target === 'task') {
            taskRunOps.push({
              updateOne: {
                filter: { runId: traceId, serviceId: context.serviceId },
                update: {
                  $push: { spans: childSpan },
                  $setOnInsert: {
                    timestamp,
                    duration: 0,
                    taskName: name || 'Internal Task',
                    status: isError ? 'failed' : 'success',
                    taskType: 'custom',
                    metadata: { source: 'opentelemetry' }
                  }
                },
                upsert: true
              }
            });
          } else if (context.target === 'rum') {
            rumTraceOps.push({
              updateOne: {
                filter: { traceId, serviceId: context.serviceId },
                update: {
                  $push: { spans: childSpan },
                  $setOnInsert: {
                    timestamp,
                    duration: 0,
                    url: 'unknown',
                    path: name || 'Internal',
                    traceType: 'resource',
                    sessionId: 'unknown',
                    ip: 'Unknown', country: 'Unknown', city: 'Unknown',
                    userAgent: 'Unknown', browser: 'Unknown', os: 'Unknown', device: 'Desktop',
                  }
                },
                upsert: true
              }
            });
          }
        }

        // -----------------------------------------------------------------
        // 3. UNIVERSAL ERROR TRACKING
        // -----------------------------------------------------------------
        if (isError || errorMsg) {
          const finalErrorClass = errorType || 'OTelException';
          const finalErrorMsg = errorMsg || span.status?.message || 'Unknown span error';
          const fingerprint = generateErrorFingerprint(context.serviceId, finalErrorClass, cleanMessageForFingerprint(finalErrorMsg));

          const errorContext = collectAttributes(attributes);
          errorContext._spanName = name;

          errorEvents.push({
            serviceId: context.serviceId,
            serviceModel: context.target === 'task' ? 'TaskService' : context.target === 'rum' ? 'RumService' : 'ApmService',
            traceId, fingerprint, stackTrace: errorStack || '',
            context: errorContext,
            timestamp
          });

          if (!errorGroupsMap.has(fingerprint)) {
            errorGroupsMap.set(fingerprint, { fingerprint, errorClass: finalErrorClass, message: finalErrorMsg, firstSeen: timestamp, lastSeen: timestamp, count: 0 });
          }
          const group = errorGroupsMap.get(fingerprint);
          group.count++;
          if (timestamp > group.lastSeen) group.lastSeen = timestamp;
          if (timestamp < group.firstSeen) group.firstSeen = timestamp;
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // 4. EXECUTE PARALLEL BULK WRITES
  // -----------------------------------------------------------------------
  const promises = [];

  // Resolve the owner's plan-based retention window once for this batch.
  const retentionMs = await getRetentionMs(context.ownerId);

  if (apmTraceOps.length > 0) {
    stampTraceOpsExpiry(apmTraceOps, retentionMs);
    promises.push(ApmTrace.bulkWrite(apmTraceOps, { ordered: false }));
  }
  if (taskRunOps.length > 0) {
    stampTraceOpsExpiry(taskRunOps, retentionMs);
    promises.push(TaskRun.bulkWrite(taskRunOps, { ordered: false }));
  }
  if (rumTraceOps.length > 0) {
    stampTraceOpsExpiry(rumTraceOps, retentionMs);
    promises.push(RumTrace.bulkWrite(rumTraceOps, { ordered: false }));
  }

  if (apmMetricsMap.size > 0) {
    const apmMetOps = Array.from(apmMetricsMap.values()).map(m => {
      const incUpdate: Record<string, any> = {
        requests: m.requests, errorCount: m.errorCount, durationSum: m.durationSum
      };

      for (const [k, v] of Object.entries(m.routes)) {
        incUpdate[`routes.${k}.count`] = (v as any).count;
        incUpdate[`routes.${k}.errors`] = (v as any).errors;
        incUpdate[`routes.${k}.duration`] = (v as any).duration;
      }

      const addMapToInc = (prefix: string, obj: Record<string, number>) => {
        for (const [k, v] of Object.entries(obj)) {
          incUpdate[`${prefix}.${k}`] = v;
        }
      };

      addMapToInc('statusCodes', m.statusCodes);
      addMapToInc('countries', m.countries);
      addMapToInc('browsers', m.browsers);
      addMapToInc('os', m.os);
      addMapToInc('devices', m.devices);

      return {
        updateOne: {
          filter: { serviceId: context.serviceId, timestamp: m.timestamp },
          update: {
            $inc: incUpdate,
            $max: { durationMax: m.durationMax },
            $set: { expiresAt: new Date(m.timestamp.getTime() + retentionMs) },
          },
          upsert: true
        }
      };
    });
    promises.push(ApmMetric.bulkWrite(apmMetOps, { ordered: false }));
  }

  if (taskMetricsMap.size > 0) {
    const taskMetOps = Array.from(taskMetricsMap.values()).map(m => ({
      updateOne: { filter: { serviceId: context.serviceId, taskName: m.taskName, timestamp: m.timestamp }, update: { $inc: { runs: m.runs, failures: m.failures, durationSum: m.durationSum }, $max: { durationMax: m.durationMax }, $set: { expiresAt: new Date(m.timestamp.getTime() + retentionMs) } }, upsert: true }
    }));
    promises.push(TaskMetric.bulkWrite(taskMetOps, { ordered: false }));
  }

  if (errorGroupsMap.size > 0) {
    const groupPromises = Array.from(errorGroupsMap.values()).map(async (g) => {
      const groupDoc = await ErrorGroup.findOneAndUpdate(
        { ownerId: context.ownerId, fingerprint: g.fingerprint },
        {
          $setOnInsert: {
            ownerId: context.ownerId, serviceId: context.serviceId, serviceModel: context.target === 'task' ? 'TaskService' : context.target === 'rum' ? 'RumService' : 'ApmService',
            fingerprint: g.fingerprint, errorClass: g.errorClass, message: g.message, firstSeen: g.firstSeen, status: 'unresolved'
          },
          $max: {
            lastSeen: g.lastSeen,
            expiresAt: new Date(g.lastSeen.getTime() + retentionMs),
          },
          $inc: { totalCount: g.count }
        },
        { upsert: true, new: true }
      );
      return { fingerprint: g.fingerprint, groupId: groupDoc._id };
    });

    promises.push(
      Promise.all(groupPromises).then(resolvedGroups => {
        const fingerprintToGroupId = new Map(resolvedGroups.map(g => [g.fingerprint, g.groupId]));
        const finalErrorEvents = errorEvents.map(e => {
          const { fingerprint, ...rest } = e;
          return { ...rest, groupId: fingerprintToGroupId.get(fingerprint) };
        });
        stampExpiry(finalErrorEvents, 'timestamp', retentionMs);
        return ErrorEvent.insertMany(finalErrorEvents, { ordered: false });
      })
    );
  }

  await Promise.allSettled(promises);
};
