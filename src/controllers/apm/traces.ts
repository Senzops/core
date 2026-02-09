import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { ApmService, ApmTrace } from '../../models/Apm';

// --- Get Recent Invocations (List) ---
export const getInvocations = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { uid } = (req as any).user;
    const { route, status, minDuration } = req.query;

    // Verify Ownership
    const service = await ApmService.findOne({ _id: id, ownerId: uid });
    if (!service) return res.status(404).json({ error: "Service not found" });

    // Build Query
    const query: any = { serviceId: id };
    
    // Filters
    if (route) query.route = decodeURIComponent(route as string);
    if (status === 'error') query.status = { $gte: 400 };
    if (minDuration) query.duration = { $gte: Number(minDuration) };

    // Fetch last 500 traces (Project only necessary fields for table)
    const traces = await ApmTrace.find(query)
      .sort({ timestamp: -1 })
      .limit(500)
      .select('method route path status duration timestamp ip country os');

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

    const trace = await ApmTrace.findOne({ serviceId: id, _id: traceId });
    if (!trace) return res.status(404).json({ error: "Trace not found" });

    res.json(trace);
  } catch (error) {
    next(error);
  }
};