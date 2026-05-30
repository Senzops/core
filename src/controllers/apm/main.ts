import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { ApmService, ApmTrace, ApmMetric } from '../../models/Apm';
import { RuntimeMetric } from '../../models/RuntimeMetric';
import { ErrorGroup, ErrorEvent } from '../../models/Error';
import { LogEvent } from '../../models/Log';
import { RegisterApmSchema, UpdateApmSchema } from '../../utils/validation';

// --- Register New Service ---
export const registerService = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { name, framework } = RegisterApmSchema.parse(req.body);

    // Generate specific APM Key (Prefix with sz_apm_ for clarity)
    const apiKey = `sz_apm_${crypto.randomBytes(24).toString('hex')}`;

    const newService = await ApmService.create({
      ownerId,
      name,
      apiKey,
      framework: framework || 'unknown'
    });

    res.status(201).json({
      message: 'Service Created',
      serviceId: newService._id,
      apiKey: newService.apiKey, // Shown once
    });
  } catch (error) {
    next(error);
  }
};

// --- List Services ---
export const listServices = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const services = await ApmService.find({ ownerId }).sort({ createdAt: -1 });
    res.json(services);
  } catch (error) {
    next(error);
  }
};

// --- Update Service ---
export const updateService = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const updates = UpdateApmSchema.parse(req.body);

    const updated = await ApmService.findOneAndUpdate(
      { _id: id, ownerId },
      updates,
      { new: true, runValidators: true }
    );
    if (!updated) return res.status(404).json({ error: 'Service not found' });

    res.json({ message: 'Service Updated', service: updated });
  } catch (error) {
    next(error);
  }
};

// --- Delete Service & Cascade Purge ---
export const deleteService = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const result = await ApmService.findOneAndDelete({ _id: id, ownerId });
    if (!result) return res.status(404).json({ error: 'Service not found' });

    // Cascade delete all telemetry associated with this service
    await Promise.all([
      ApmTrace.deleteMany({ serviceId: id }),
      ApmMetric.deleteMany({ serviceId: id }),
      RuntimeMetric.deleteMany({ serviceId: id }),
      ErrorGroup.deleteMany({ serviceId: id, serviceModel: 'ApmService' }),
      ErrorEvent.deleteMany({ serviceId: id, serviceModel: 'ApmService' }),
      LogEvent.deleteMany({ serviceId: id, serviceModel: 'ApmService' }),
    ]);

    res.json({ message: 'Service and all associated telemetry successfully purged.' });
  } catch (error) {
    next(error);
  }
};