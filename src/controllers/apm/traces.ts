import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { ApmService, ApmTrace } from '../../models/Apm';
import { RumService, RumTrace } from '../../models/Rum';
import { resolveTimeRange, getEffectiveRetention, TimeRangeError } from '../../utils/timeRange';

// --- Get Recent Invocations (List) ---
export const getInvocations = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const ownerId = (req as any).ownerId;
    const { range, start, end, route, status, minDuration } = req.query;

    // 1. Verify Ownership
    const service = await ApmService.findOne({ _id: id, ownerId });
    if (!service) return res.status(404).json({ error: "Service not found" });

    // 2. Resolve time range via centralized utility
    const maxRetention = await getEffectiveRetention('apm', ownerId);
    const resolved = resolveTimeRange(
      { range: range as string | undefined, start: start as string | undefined, end: end as string | undefined },
      maxRetention
    );

    // 3. Build Query
    const query: any = {
      serviceId: id,
      timestamp: { $gte: resolved.startDate, $lte: resolved.endDate }
    };

    // Optional Filters
    if (route) query.route = decodeURIComponent(route as string);
    if (status === 'error') query.status = { $gte: 400 };
    if (minDuration) query.duration = { $gte: Number(minDuration) };

    // 4. Fetch Traces
    // Increased limit to 2000 to support "View All" feel while preventing OOM on massive ranges
    const traces = await ApmTrace.find(query)
      .sort({ timestamp: -1 })
      .limit(2000)
      .select('method route path status duration timestamp ip country city os browser device')
      .lean();

    res.json(traces);
  } catch (error) {
    if (error instanceof TimeRangeError) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
};

// --- Get Full Trace Detail (Waterfall) ---
export const getTraceDetail = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, traceId } = req.params;
    const ownerId = (req as any).ownerId;

    const service = await ApmService.findOne({ _id: id, ownerId });
    if (!service) return res.status(404).json({ error: "Service not found" });

    // 1. Fetch Main Trace
    const traceQuery: any = { serviceId: id };
    if (mongoose.Types.ObjectId.isValid(traceId)) {
      traceQuery.$or = [{ _id: traceId }, { traceId: traceId }];
    } else {
      traceQuery.traceId = traceId;
    }
    const trace = await ApmTrace.findOne(traceQuery).lean();
    if (!trace) return res.status(404).json({ error: "Trace not found" });

    // Normalize absolute OTLP timestamps to relative milliseconds dynamically
    const normalizeSpans = (spans: any[], rootTime: Date) => {
      const rootMs = new Date(rootTime).getTime();
      return spans.map(s => {
        if (s.startTime > 1000000000) { 
           return { ...s, startTime: Math.max(0, s.startTime - rootMs) };
        }
        return s;
      });
    };
    trace.spans = normalizeSpans(trace.spans || [], trace.timestamp);

    // 2. Find Related APM Services (Owned by same user)
    const userServices = await ApmService.find({ ownerId }).select('_id name').lean();
    const serviceIds = userServices.map(s => s._id);

    // Helper Map: ServiceID -> ServiceName
    const serviceMap = userServices.reduce((acc: any, curr) => {
      acc[curr._id.toString()] = curr.name;
      return acc;
    }, {});

    // 3. Find Children (Downstream APM Calls)
    // Extract all span IDs that were initiated by THIS trace
    const spanIds = trace.spans?.map((s: any) => s.spanId).filter(Boolean) || [];

    const childQuery: any = {
      serviceId: { $in: serviceIds },
      _id: { $ne: trace._id } // CRITICAL FIX: Prevent self-referencing infinite loops
    };

    const orConditions = [];
    if (spanIds.length > 0) orConditions.push({ parentSpanId: { $in: spanIds } });
    if (trace.traceId) orConditions.push({ parentTraceId: trace.traceId });
    orConditions.push({ parentTraceId: trace._id.toString() }); // Legacy fallback
    childQuery.$or = orConditions;

    const childTraces = await ApmTrace.find(childQuery)
      .select('serviceId traceId parentSpanId parentTraceId status duration method route timestamp hasErrors')
      .lean();

    // 4. Find Parent (Upstream Call)
    let parentTrace: any = null;

    // 4A. W3C Standard: Try to find an APM trace whose specific span spawned this trace
    if (trace.parentSpanId) {
      parentTrace = await ApmTrace.findOne({
        serviceId: { $in: serviceIds },
        traceId: trace.traceId,
        "spans.spanId": trace.parentSpanId,
        _id: { $ne: trace._id }
      })
        .select('serviceId traceId status duration method route')
        .lean();
    }

    // 4B. Legacy APM Agent Fallback
    if (!parentTrace && trace.parentTraceId && trace.parentTraceId !== trace.traceId) {
      parentTrace = await ApmTrace.findOne({
        serviceId: { $in: serviceIds },
        $or: [{ traceId: trace.parentTraceId }, { _id: trace.parentTraceId }],
        _id: { $ne: trace._id }
      })
        .select('serviceId traceId status duration method route')
        .lean();
    }

    // 4C. RUM Fallback (Frontend Initiator): 
    // If no APM parent exists, but a RUM trace shares the identical global traceId, 
    // it means this backend trace was triggered by a frontend fetch/XHR!
    if (!parentTrace && trace.traceId) {
      const rumServices = await RumService.find({ ownerId }).select('_id name').lean();
      if (rumServices.length > 0) {
        const rumParent = await RumTrace.findOne({
          serviceId: { $in: rumServices.map(s => s._id) },
          traceId: trace.traceId
        }).lean();

        if (rumParent) {
          const rumSvcName = rumServices.find(s => s._id.toString() === rumParent.serviceId.toString())?.name || 'Web App';
          parentTrace = {
            _id: rumParent._id,
            traceId: rumParent.traceId,
            serviceId: rumParent.serviceId,
            serviceName: rumSvcName,
            method: 'RUM',
            route: rumParent.path,
            duration: rumParent.duration,
            status: 200,
            type: 'rum' // Custom tag so the frontend can style it as a RUM node
          };
        }
      }
    }

    // Resolve APM service name if it was found in 4A or 4B
    if (parentTrace && parentTrace.type !== 'rum') {
      parentTrace.serviceName = serviceMap[parentTrace.serviceId.toString()] || 'Unknown Service';
    }

    // 5. Construct Final Response
    res.json({
      ...trace,
      children: childTraces.map(c => ({
        ...c,
        serviceName: serviceMap[c.serviceId.toString()] || 'Unknown Service'
      })),
      parent: parentTrace || null
    });

  } catch (error) {
    next(error);
  }
};