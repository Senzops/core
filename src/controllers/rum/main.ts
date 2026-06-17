import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { RumService, RumTrace, RumMetric } from '../../models/Rum';
import { ErrorGroup, ErrorEvent } from '../../models/Error';
import { DashboardShare } from '../../models/DashboardShare';

// --- Register New RUM Service ---
export const registerService = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { name, domains } = req.body; // 'domains' is expected as a comma-separated string

    if (!name || !domains) {
      return res.status(400).json({ error: "Name and Domains are required." });
    }

    // 1. Split, trim, and heavily sanitize the domains
    const domainArray = domains
      .split(',')
      .map((d: string) => d.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase())
      .filter(Boolean);

    if (domainArray.length === 0) {
      return res.status(400).json({ error: "At least one valid domain is required." });
    }

    const apiKey = `sz_rum_${crypto.randomBytes(24).toString('hex')}`;

    const newService = await RumService.create({
      ownerId,
      name,
      domains: domainArray,
      apiKey,
      samplingRate: 1.0
    });

    res.status(201).json({
      message: 'RUM Service Created',
      serviceId: newService._id,
      apiKey: newService.apiKey,
      domains: newService.domains
    });
  } catch (error) {
    next(error);
  }
};

// --- List RUM Services ---
export const listServices = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const services = await RumService.find({ ownerId })
      .select('-apiKey')
      .sort({ createdAt: -1 })
      .lean();

    res.json(services);
  } catch (error) {
    next(error);
  }
};

// --- Update RUM Service ---
export const updateRumService = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const { name, domains } = req.body;

    if (!name && !domains) {
      return res.status(400).json({ error: 'At least one field (name or domains) must be provided.' });
    }

    const updateFields: Record<string, any> = {};
    if (name) {
      if (name.length > 50) return res.status(400).json({ error: 'Name must be at most 50 characters' });
      updateFields.name = name;
    }
    if (domains) {
      const domainArray = domains
        .split(',')
        .map((d: string) => d.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase())
        .filter(Boolean);

      if (domainArray.length === 0) {
        return res.status(400).json({ error: 'At least one valid domain is required.' });
      }
      updateFields.domains = domainArray;
    }

    const updated = await RumService.findOneAndUpdate(
      { _id: id, ownerId },
      updateFields,
      { new: true, runValidators: true }
    ).select('-apiKey');
    if (!updated) return res.status(404).json({ error: 'RUM Service not found' });

    res.json({ message: 'RUM Service Updated', service: updated });
  } catch (error) {
    next(error);
  }
};

// --- Delete RUM Service & Cascade Purge ---
export const deleteService = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const result = await RumService.findOneAndDelete({ _id: id, ownerId });
    if (!result) return res.status(404).json({ error: 'RUM Service not found' });

    const traceDelete = RumTrace.deleteMany({ serviceId: id });
    const metricDelete = RumMetric.deleteMany({ serviceId: id });
    const errorGroupDelete = ErrorGroup.deleteMany({ serviceId: id, serviceModel: 'RumService' });
    const errorEventDelete = ErrorEvent.deleteMany({ serviceId: id, serviceModel: 'RumService' });

    await Promise.all([
      traceDelete,
      metricDelete,
      errorGroupDelete,
      errorEventDelete,
      DashboardShare.deleteMany({ scopeType: 'rum', scopeId: id, ownerId }),
    ]);

    res.json({ message: 'RUM Service and all associated telemetry successfully purged.' });
  } catch (error) {
    next(error);
  }
};