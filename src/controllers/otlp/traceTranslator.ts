import mongoose from 'mongoose';
import { OtlpContext } from '../../middlewares/otlpAuth';
import { ApmTrace, ApmMetric } from '../../models/Apm';
import { TaskRun, TaskMetric } from '../../models/Task';
import { RumTrace } from '../../models/Rum';
import { ErrorGroup, ErrorEvent, generateErrorFingerprint } from '../../models/Error';

const getAttribute = (attributes: any[], key: string) => {
  const attr = attributes?.find(a => a.key === key);
  if (!attr || !attr.value) return undefined;
  return attr.value.stringValue || attr.value.intValue || attr.value.boolValue || attr.value.doubleValue;
};

const cleanMessageForFingerprint = (message: string): string => {
  return message
    .replace(/[0-9a-fA-F]{24}/g, '<id>')
    .replace(/\b[0-9a-f]{8}\b-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-\b[0-9a-f]{12}\b/ig, '<uuid>')
    .replace(/\d+/g, '<num>');
};

export const translateOtlpTraces = async (context: OtlpContext, resourceSpans: any[]) => {
  const apmTraceOps: any[] = [];
  const taskRunOps: any[] = [];
  const rumTraceOps: any[] = [];

  const apmMetricsMap = new Map<string, any>();
  const taskMetricsMap = new Map<string, any>();

  const errorEvents: any[] = [];
  const errorGroupsMap = new Map<string, any>();

  for (const rs of resourceSpans) {
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
        const dbStatement = getAttribute(attributes, 'db.statement') || getAttribute(attributes, 'db.query.text');

        const errorMsg = getAttribute(attributes, 'error.message') || getAttribute(attributes, 'exception.message');
        const errorType = getAttribute(attributes, 'error.type') || getAttribute(attributes, 'exception.type');
        const errorStack = getAttribute(attributes, 'exception.stacktrace');

        // Status logic (OTel Code 2 = ERROR)
        const isError = span.status?.code === 2;
        const spanStatus = isError ? (httpStatusCode || 500) : (httpStatusCode || 200);

        // Heuristic: Is this an entry point (Root Span) for this specific microservice?
        const isRoot = kind === 2 || kind === 5; // SERVER or CONSUMER

        if (isRoot) {
          // --- 1. ROOT SPAN REGISTRATION ---
          if (context.target === 'apm') {
            const route = httpRoute || httpTarget || name || 'Unknown Route';
            const path = httpTarget || httpUrl || name || 'Unknown Path';
            const method = httpMethod || 'INTERNAL';

            apmTraceOps.push({
              updateOne: {
                filter: { traceId, serviceId: context.serviceId },
                update: {
                  $set: {
                    serviceId: context.serviceId, traceId, parentSpanId,
                    method, route, path, status: spanStatus, duration, timestamp, hasErrors: isError
                  }
                },
                upsert: true
              }
            });

            // Aggregate APM Metrics
            const bucketTime = new Date(timestamp);
            bucketTime.setSeconds(0, 0);
            const bucketKey = bucketTime.toISOString();
            if (!apmMetricsMap.has(bucketKey)) {
              apmMetricsMap.set(bucketKey, { timestamp: bucketTime, requests: 0, errorCount: 0, durationSum: 0, durationMax: 0, routes: {}, statusCodes: {} });
            }
            const m = apmMetricsMap.get(bucketKey);
            m.requests++;
            if (isError) m.errorCount++;
            m.durationSum += duration;
            if (duration > m.durationMax) m.durationMax = duration;
            const safeRoute = `${method} ${route}`.replace(/\./g, '_').replace(/\$/g, '');
            
            // Enterprise Object tracking for routes
            if (!m.routes[safeRoute]) {
              m.routes[safeRoute] = { count: 0, errors: 0, duration: 0 };
            }
            m.routes[safeRoute].count += 1;
            if (isError) m.routes[safeRoute].errors += 1;
            m.routes[safeRoute].duration += duration;

            m.statusCodes[spanStatus] = (m.statusCodes[spanStatus] || 0) + 1;

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
            rumTraceOps.push({
              updateOne: {
                filter: { traceId, serviceId: context.serviceId },
                update: {
                  $set: {
                    serviceId: context.serviceId, traceId,
                    sessionId: getAttribute(attributes, 'session.id') || 'unknown',
                    traceType: 'route_change', url: httpUrl || 'unknown', path: httpTarget || name || 'Unknown Path',
                    duration, timestamp,
                    ip: '0.0.0.0', country: 'Unknown', city: 'Unknown', userAgent: 'OTel-Agent', browser: 'Unknown', os: 'Unknown', device: 'Unknown'
                  }
                },
                upsert: true
              }
            });
          }

        } else {
          // --- 2. CHILD SPAN REGISTRATION ---
          const type = dbSystem ? 'db' : (httpMethod ? 'http' : 'custom');
          const childSpan = {
            spanId, name, type,
            // Storing absolute MS. Read controllers will dynamically map to relative MS for the Waterfall UI.
            startTime: startTimeMs,
            duration, status: spanStatus,
            meta: { 'db.system': dbSystem, 'db.statement': dbStatement, 'http.url': httpUrl, 'error': errorMsg }
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
                    hasErrors: isError
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
                    ip: '0.0.0.0', country: 'Unknown', city: 'Unknown', userAgent: 'OTel-Agent', browser: 'Unknown', os: 'Unknown', device: 'Unknown'
                  }
                }, 
                upsert: true 
              } 
            });
          }
        }

        // --- 3. UNIVERSAL ERROR TRACKING ---
        if (isError || errorMsg) {
          const finalErrorClass = errorType || 'OTelException';
          const finalErrorMsg = errorMsg || span.status?.message || 'Unknown span error';
          const fingerprint = generateErrorFingerprint(context.serviceId, finalErrorClass, cleanMessageForFingerprint(finalErrorMsg));

          errorEvents.push({
            serviceId: context.serviceId,
            serviceModel: context.target === 'task' ? 'TaskService' : context.target === 'rum' ? 'RumService' : 'ApmService',
            traceId, fingerprint, stackTrace: errorStack || '',
            context: { spanName: name, attributes: attributes.reduce((acc: any, curr: any) => { acc[curr.key] = curr.value.stringValue || curr.value.intValue; return acc; }, {}) },
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

  // --- 4. EXECUTE PARALLEL BULK WRITES ---
  const promises = [];

  if (apmTraceOps.length > 0) promises.push(ApmTrace.bulkWrite(apmTraceOps, { ordered: false }));
  if (taskRunOps.length > 0) promises.push(TaskRun.bulkWrite(taskRunOps, { ordered: false }));
  if (rumTraceOps.length > 0) promises.push(RumTrace.bulkWrite(rumTraceOps, { ordered: false }));

  if (apmMetricsMap.size > 0) {
    const apmMetOps = Array.from(apmMetricsMap.values()).map(m => {
      const incUpdate: any = { requests: m.requests, errorCount: m.errorCount, durationSum: m.durationSum };
      Object.entries(m.routes).forEach(([k, v]: [string, any]) => {
        incUpdate[`routes.${k}.count`] = v.count;
        incUpdate[`routes.${k}.errors`] = v.errors;
        incUpdate[`routes.${k}.duration`] = v.duration;
      });
      Object.entries(m.statusCodes).forEach(([k, v]) => incUpdate[`statusCodes.${k}`] = v);
      return { updateOne: { filter: { serviceId: context.serviceId, timestamp: m.timestamp }, update: { $inc: incUpdate, $max: { durationMax: m.durationMax } }, upsert: true } };
    });
    promises.push(ApmMetric.bulkWrite(apmMetOps, { ordered: false }));
  }

  if (taskMetricsMap.size > 0) {
    const taskMetOps = Array.from(taskMetricsMap.values()).map(m => ({
      updateOne: { filter: { serviceId: context.serviceId, taskName: m.taskName, timestamp: m.timestamp }, update: { $inc: { runs: m.runs, failures: m.failures, durationSum: m.durationSum }, $max: { durationMax: m.durationMax } }, upsert: true }
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
          $max: { lastSeen: g.lastSeen }, $inc: { totalCount: g.count }
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
        return ErrorEvent.insertMany(finalErrorEvents, { ordered: false });
      })
    );
  }

  await Promise.allSettled(promises);
};