import { Request, Response, NextFunction } from 'express';
import { ApmErrorGroup, ApmErrorEvent } from '../../models/ApmError';

// 1. Get Global Errors (For the /errors/default Dashboard)
export const getGlobalErrors = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string;
    const status = req.query.status as string || 'unresolved';

    const query: any = { ownerId: uid, status };

    // Text search on error class or message
    if (search) {
      query.$or = [
        { errorClass: { $regex: search, $options: 'i' } },
        { message: { $regex: search, $options: 'i' } }
      ];
    }

    const [groups, total] = await Promise.all([
      ApmErrorGroup.find(query)
        .sort({ lastSeen: -1 }) // Recent first
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('apmId', 'name framework') // Pull in the service name
        .lean(),
      ApmErrorGroup.countDocuments(query)
    ]);

    res.json({
      errors: groups,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    next(error);
  }
};

// 2. Get Specific Error Details & Occurrences
export const getErrorGroupDetails = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { groupId } = req.params;

    // Verify ownership
    const group = await ApmErrorGroup.findOne({ _id: groupId, ownerId: uid })
      .populate('apmId', 'name framework')
      .lean();

    if (!group) return res.status(404).json({ error: 'Error group not found' });

    // Fetch the 50 most recent occurrences for the waterfall / detail view
    const events = await ApmErrorEvent.find({ groupId })
      .sort({ timestamp: -1 })
      .limit(50)
      .lean();

    res.json({ group, events });
  } catch (error) {
    next(error);
  }
};

// 3. Mark Error as Resolved/Ignored
export const updateErrorStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { groupId } = req.params;
    const { status } = req.body;

    if (!['unresolved', 'resolved', 'ignored'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const updated = await ApmErrorGroup.findOneAndUpdate(
      { _id: groupId, ownerId: uid },
      { $set: { status } },
      { new: true }
    );

    if (!updated) return res.status(404).json({ error: 'Error group not found' });

    res.json({ message: 'Status updated', group: updated });
  } catch (error) {
    next(error);
  }
};