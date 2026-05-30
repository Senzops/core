import { Request, Response, NextFunction } from 'express';
import { Website, WebEvent, WebMetric } from '../../models/Web';
import { User } from '../../models/User';
import { RegisterWebsiteSchema, UpdateWebsiteSchema } from '../../utils/validation';

// --- Register a new Website ---
export const registerWebsite = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { email } = (req as any).user;
    const { name, domain } = RegisterWebsiteSchema.parse(req.body);

    const newSite = await Website.create({
      ownerId,
      name,
      domain,
    });

    res.status(201).json({
      message: 'Website Registered',
      webId: newSite._id, // This is the ID the user puts in the Script
      name: newSite.name,
      domain: newSite.domain
    });
  } catch (error) {
    next(error);
  }
};

// --- List User's Websites ---
export const listWebsites = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;

    // We fetch the site details
    // In a real prod app, you might aggregate 'live visitors' here too
    const sites = await Website.find({ ownerId }).sort({ createdAt: -1 });

    res.json(sites);
  } catch (error) {
    next(error);
  }
};

// --- Update Website ---
export const updateWebsite = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const updates = UpdateWebsiteSchema.parse(req.body);

    const updated = await Website.findOneAndUpdate(
      { _id: id, ownerId },
      updates,
      { new: true, runValidators: true }
    );
    if (!updated) return res.status(404).json({ error: 'Website not found' });

    res.json({ message: 'Website Updated', website: updated });
  } catch (error) {
    next(error);
  }
};

// --- Delete Website & Cascade Purge ---
export const deleteWebsite = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const result = await Website.findOneAndDelete({ _id: id, ownerId });
    if (!result) return res.status(404).json({ error: 'Website not found' });

    // Cascade delete all analytics data for this site
    await Promise.all([
      WebEvent.deleteMany({ webId: id }),
      WebMetric.deleteMany({ webId: id }),
    ]);

    res.json({ message: 'Website and all associated analytics data successfully purged.' });
  } catch (error) {
    next(error);
  }
};