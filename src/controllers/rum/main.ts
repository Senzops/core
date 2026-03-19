import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { RumService, RumTrace, RumMetric } from '../../models/Rum';
import { ErrorGroup, ErrorEvent } from '../../models/Error';
import { RegisterRumSchema } from '../../utils/validation';

// --- Register New RUM Service ---
export const registerService = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    
    // Validates name and domain (ensures domain is a valid format)
    const { name, domain } = RegisterRumSchema.parse(req.body);

    // Generate specific RUM Key (Prefix with sz_rum_ for explicit clarity in the UI)
    const apiKey = `sz_rum_${crypto.randomBytes(24).toString('hex')}`;

    const newService = await RumService.create({
      ownerId: uid,
      name,
      domain,
      apiKey,
      samplingRate: 1.0 // Default to 100% capture
    });

    res.status(201).json({
      message: 'RUM Service Created',
      serviceId: newService._id,
      apiKey: newService.apiKey, // Shown ONCE to the user
      domain: newService.domain
    });
  } catch (error) {
    next(error);
  }
};

// --- List RUM Services ---
export const listServices = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    
    // We don't select the apiKey here for security reasons. 
    // If they lose it, they must rotate/re-create the service.
    const services = await RumService.find({ ownerId: uid })
      .select('-apiKey') 
      .sort({ createdAt: -1 })
      .lean();
      
    res.json(services);
  } catch (error) {
    next(error);
  }
};

// --- Delete RUM Service & Cascade Purge ---
export const deleteService = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;

    const result = await RumService.findOneAndDelete({ _id: id, ownerId: uid });
    if (!result) return res.status(404).json({ error: 'RUM Service not found' });

    // 1. Cascade delete raw traces
    const traceDelete = RumTrace.deleteMany({ serviceId: id });
    
    // 2. Cascade delete aggregated time-series metrics
    const metricDelete = RumMetric.deleteMany({ serviceId: id });

    // 3. Cascade delete Universal Errors securely (Ensure we only delete errors belonging to THIS model)
    const errorGroupDelete = ErrorGroup.deleteMany({ serviceId: id, serviceModel: 'RumService' });
    const errorEventDelete = ErrorEvent.deleteMany({ serviceId: id, serviceModel: 'RumService' });

    // Execute all purges concurrently for performance
    await Promise.all([traceDelete, metricDelete, errorGroupDelete, errorEventDelete]);

    res.json({ message: 'RUM Service and all associated telemetry successfully purged.' });
  } catch (error) {
    next(error);
  }
};