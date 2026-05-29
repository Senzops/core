import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { ApmService, ApmTrace } from '../../models/Apm';
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

// --- Delete Service ---
export const deleteService = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const result = await ApmService.findOneAndDelete({ _id: id, ownerId });
    if (!result) return res.status(404).json({ error: 'Service not found' });

    // Cascade delete traces
    await ApmTrace.deleteMany({ serviceId: id });

    res.json({ message: 'Service and traces deleted' });
  } catch (error) {
    next(error);
  }
};