import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { ApmService, ApmTrace } from '../../models/Apm';
import { RegisterApmSchema } from '../../utils/validation';

// --- Register New Service ---
export const registerService = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { name, framework } = RegisterApmSchema.parse(req.body);

    // Generate specific APM Key (Prefix with sz_apm_ for clarity)
    const apiKey = `sz_apm_${crypto.randomBytes(24).toString('hex')}`;

    const newService = await ApmService.create({
      ownerId: uid,
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
    const { uid } = (req as any).user;
    const services = await ApmService.find({ ownerId: uid }).sort({ createdAt: -1 });
    res.json(services);
  } catch (error) {
    next(error);
  }
};

// --- Delete Service ---
export const deleteService = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;

    const result = await ApmService.findOneAndDelete({ _id: id, ownerId: uid });
    if (!result) return res.status(404).json({ error: 'Service not found' });

    // Cascade delete traces
    await ApmTrace.deleteMany({ serviceId: id });

    res.json({ message: 'Service and traces deleted' });
  } catch (error) {
    next(error);
  }
};