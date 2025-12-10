import { Request, Response, NextFunction } from 'express';
import { Website, WebEvent, User } from '../models';
import { RegisterWebsiteSchema } from '../utils/validation';

// --- Register a new Website ---
export const registerWebsite = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid, email } = (req as any).user;
    const { name, domain } = RegisterWebsiteSchema.parse(req.body);

    // Ensure user exists in our DB (Syncing with Firebase)
    await User.findOneAndUpdate(
      { firebaseUid: uid },
      { firebaseUid: uid, email },
      { upsert: true, new: true }
    );

    const newSite = await Website.create({
      ownerId: uid,
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
    const { uid } = (req as any).user;

    // We fetch the site details
    // In a real prod app, you might aggregate 'live visitors' here too
    const sites = await Website.find({ ownerId: uid }).sort({ createdAt: -1 });

    res.json(sites);
  } catch (error) {
    next(error);
  }
};

// --- Delete Website ---
export const deleteWebsite = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;

    const result = await Website.findOneAndDelete({ _id: id, ownerId: uid });
    if (!result) return res.status(404).json({ error: 'Website not found' });

    // Cascade delete all analytics data for this site
    await WebEvent.deleteMany({ webId: id });

    res.json({ message: 'Website and data deleted' });
  } catch (error) {
    next(error);
  }
};