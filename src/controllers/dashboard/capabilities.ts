import { Request, Response, NextFunction } from 'express';
import { getAllRetentionLimits, RELATIVE_RANGES } from '../../utils/timeRange';

export const getDashboardCapabilities = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const retentionLimits = await getAllRetentionLimits(uid);

    res.json({
      relativeRanges: RELATIVE_RANGES,
      services: retentionLimits,
    });
  } catch (error) {
    next(error);
  }
};
