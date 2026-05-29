import { Request, Response, NextFunction } from 'express';
import { getAllRetentionLimits, RELATIVE_RANGES } from '../../utils/timeRange';

export const getDashboardCapabilities = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const retentionLimits = await getAllRetentionLimits(ownerId);

    res.json({
      relativeRanges: RELATIVE_RANGES,
      services: retentionLimits,
    });
  } catch (error) {
    next(error);
  }
};
