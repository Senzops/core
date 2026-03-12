import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { ApmService, ApmTrace } from '../../models/Apm';

// --- Get Recent Invocations (List) ---
export const getInvocations = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { uid } = (req as any).user;
    const { range, route, status, minDuration } = req.query;

    // 1. Verify Ownership
    const service = await ApmService.findOne({ _id: id, ownerId: uid });
    if (!service) return res.status(404).json({ error: "Service not found" });

    // 2. Calculate Date Range
    const now = new Date();
    const startDate = new Date();

    if (range === '7d') startDate.setDate(now.getDate() - 7);
    else if (range === '30d') startDate.setDate(now.getDate() - 30);
    else if (range === '1h') startDate.setHours(now.getHours() - 1);
    else startDate.setHours(now.getHours() - 24); // Default 24h

    // 3. Build Query
    const query: any = {
      serviceId: id,
      timestamp: { $gte: startDate } // Apply Time Filter
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
    next(error);
  }
};

// --- Get Full Trace Detail (Waterfall) ---
export const getTraceDetail = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id, traceId } = req.params;
    const { uid } = (req as any).user;

    const service = await ApmService.findOne({ _id: id, ownerId: uid });
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

    // 2. Find Related Services (Owned by same user)
    const userServices = await ApmService.find({ ownerId: uid }).select('_id name').lean();
    const serviceIds = userServices.map(s => s._id);

    // Helper Map: ServiceID -> ServiceName
    const serviceMap = userServices.reduce((acc: any, curr) => {
      acc[curr._id.toString()] = curr.name;
      return acc;
    }, {});

    // 3. Find Children (Downstream Calls)
    // We look for traces that list THIS trace as their parent
    const childTraces = await ApmTrace.find({
      parentTraceId: trace.traceId,
      serviceId: { $in: serviceIds }
    })
      .select('serviceId traceId parentSpanId status duration method route timestamp')
      .lean();

    // 4. Find Parent (Upstream Call)
    let parentTrace = null;
    if (trace.parentTraceId) {
      parentTrace = await ApmTrace.findOne({
        traceId: trace.parentTraceId,
        serviceId: { $in: serviceIds }
      })
        .select('serviceId traceId status duration method route')
        .lean();
    }

    // 5. Construct Response
    res.json({
      ...trace,
      children: childTraces.map(c => ({
        ...c,
        serviceName: serviceMap[c.serviceId.toString()] || 'Unknown Service'
      })),
      parent: parentTrace ? {
        ...parentTrace,
        serviceName: serviceMap[parentTrace.serviceId.toString()] || 'Unknown Service'
      } : null
    });

  } catch (error) {
    next(error);
  }
};