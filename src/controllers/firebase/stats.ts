import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { FirebaseService, FirebaseMetric, FirebaseAuthSnapshot } from '../../models/Firebase';
import { resolveTimeRange, getEffectiveRetention, buildTimeRangeMeta, TimeRangeError } from '../../utils/timeRange';

export const getFirebaseStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const ownerId = (req as any).ownerId;
    const { range, start, end } = req.query;

    const service = await FirebaseService.findOne({ _id: id, ownerId }).select('-encryptedServiceAccount');
    if (!service) return res.status(404).json({ error: 'Firebase service not found' });

    const maxRetention = await getEffectiveRetention('firebase', ownerId);
    const resolved = resolveTimeRange(
      { range: range as string, start: start as string, end: end as string },
      maxRetention
    );
    const { startDate, endDate, bucketFormat } = resolved;
    const meta = buildTimeRangeMeta(resolved, maxRetention);

    const matchQuery = {
      serviceId: new mongoose.Types.ObjectId(id),
      timestamp: { $gte: startDate, $lte: endDate }
    };

    const [latestMetric, historyRaw, authSnapshot] = await Promise.all([
      FirebaseMetric.findOne({ serviceId: id }).sort({ timestamp: -1 }).lean(),

      FirebaseMetric.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: {
              $dateToString: {
                format: bucketFormat,
                date: '$timestamp'
              }
            },
            totalUsers: { $avg: '$auth.totalUsers' },
            activeUsersDaily: { $avg: '$auth.activeUsersDaily' },
            activeUsersMonthly: { $avg: '$auth.activeUsersMonthly' },
            newSignups24h: { $avg: '$auth.newSignups24h' },
            disabledUsers: { $avg: '$auth.disabledUsers' },
            emailVerifiedCount: { $avg: '$auth.emailVerifiedCount' },
            mfaEnrolledCount: { $avg: '$auth.mfaEnrolledCount' },
            anonymousUsers: { $avg: '$auth.anonymousUsers' },
            recentSignIns1h: { $avg: '$auth.recentSignIns1h' },
            provPassword: { $avg: '$providers.password' },
            provGoogle: { $avg: '$providers.google' },
            provApple: { $avg: '$providers.apple' },
            provPhone: { $avg: '$providers.phone' },
            provGithub: { $avg: '$providers.github' },
            provMicrosoft: { $avg: '$providers.microsoft' },
            provFacebook: { $avg: '$providers.facebook' },
            provTwitter: { $avg: '$providers.twitter' },
            provAnonymous: { $avg: '$providers.anonymous' },
            provOther: { $avg: '$providers.other' }
          }
        },
        { $sort: { '_id': 1 } },
        {
          $project: {
            time: '$_id',
            totalUsers: 1,
            activeUsersDaily: 1,
            activeUsersMonthly: 1,
            newSignups24h: 1,
            disabledUsers: 1,
            emailVerifiedCount: 1,
            mfaEnrolledCount: 1,
            anonymousUsers: 1,
            recentSignIns1h: 1,
            provPassword: 1,
            provGoogle: 1,
            provApple: 1,
            provPhone: 1,
            provGithub: 1,
            provMicrosoft: 1,
            provFacebook: 1,
            provTwitter: 1,
            provAnonymous: 1,
            provOther: 1
          }
        }
      ]),

      FirebaseAuthSnapshot.findOne({ serviceId: id }).lean()
    ]);

    res.json({
      service,
      timeRange: meta,
      latest: latestMetric || {},
      history: historyRaw,
      recentUsers: authSnapshot?.recentUsers || []
    });
  } catch (error) {
    if (error instanceof TimeRangeError) return res.status(400).json({ error: error.message });
    next(error);
  }
};
