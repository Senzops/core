import cron from 'node-cron';
import admin from 'firebase-admin';
import { FirebaseService, FirebaseMetric, FirebaseAuthSnapshot, IFirebaseService } from '../models/Firebase';
import { decrypt } from '../utils/crypto';
import { logger } from '../utils/logger';

const appPool = new Map<string, admin.app.App>();
const PROCESSOR_TIMEOUT_MS = 90_000;
const BATCH_SIZE = 50;
const MAX_USERS_TO_SCAN = 100_000;

function getOrCreateApp(serviceId: string, serviceAccountJson: string): admin.app.App {
  const existing = appPool.get(serviceId);
  if (existing) return existing;

  const serviceAccount = JSON.parse(serviceAccountJson);
  const app = admin.initializeApp(
    { credential: admin.credential.cert(serviceAccount) },
    `firebase-monitor-${serviceId}`
  );
  appPool.set(serviceId, app);
  return app;
}

export function removeApp(serviceId: string): void {
  const app = appPool.get(serviceId);
  if (app) {
    app.delete().catch(() => {});
    appPool.delete(serviceId);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

const KNOWN_PROVIDERS: Record<string, string> = {
  'password': 'password',
  'google.com': 'google',
  'apple.com': 'apple',
  'phone': 'phone',
  'github.com': 'github',
  'microsoft.com': 'microsoft',
  'facebook.com': 'facebook',
  'twitter.com': 'twitter',
};

async function processFirebaseProject(service: IFirebaseService): Promise<void> {
  let decryptedSa: string;
  try {
    decryptedSa = decrypt(service.encryptedServiceAccount);
  } catch {
    throw new Error('Failed to decrypt service account credentials');
  }

  const app = getOrCreateApp(service._id.toString(), decryptedSa);
  const auth = app.auth();

  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  let totalUsers = 0;
  let activeUsersDaily = 0;
  let activeUsersMonthly = 0;
  let newSignups24h = 0;
  let disabledUsers = 0;
  let emailVerifiedCount = 0;
  let mfaEnrolledCount = 0;
  let anonymousUsers = 0;
  let recentSignIns1h = 0;

  const providers: Record<string, number> = {
    password: 0, google: 0, apple: 0, phone: 0,
    github: 0, microsoft: 0, facebook: 0, twitter: 0,
    anonymous: 0, other: 0
  };

  const recentUsersBuffer: any[] = [];
  let pageToken: string | undefined;

  do {
    const listResult = await auth.listUsers(1000, pageToken);

    for (const user of listResult.users) {
      totalUsers++;

      if (user.disabled) disabledUsers++;
      if (user.emailVerified) emailVerifiedCount++;

      const hasEnrolledFactors = user.multiFactor?.enrolledFactors && user.multiFactor.enrolledFactors.length > 0;
      if (hasEnrolledFactors) mfaEnrolledCount++;

      const createdAt = user.metadata.creationTime ? new Date(user.metadata.creationTime) : null;
      const lastSignIn = user.metadata.lastSignInTime ? new Date(user.metadata.lastSignInTime) : null;

      if (createdAt && createdAt >= oneDayAgo) newSignups24h++;
      if (lastSignIn && lastSignIn >= oneDayAgo) activeUsersDaily++;
      if (lastSignIn && lastSignIn >= thirtyDaysAgo) activeUsersMonthly++;
      if (lastSignIn && lastSignIn >= oneHourAgo) recentSignIns1h++;

      const userProviders = user.providerData || [];

      if (userProviders.length === 0) {
        anonymousUsers++;
        providers.anonymous++;
      } else {
        for (const prov of userProviders) {
          const mapped = KNOWN_PROVIDERS[prov.providerId];
          if (mapped) providers[mapped]++;
          else providers.other++;
        }
      }

      if (createdAt && createdAt >= oneDayAgo && recentUsersBuffer.length < 50) {
        recentUsersBuffer.push({
          uid: user.uid,
          email: user.email || undefined,
          displayName: user.displayName || undefined,
          createdAt,
          lastSignIn,
          providers: userProviders.map(p => p.providerId),
          mfaEnabled: !!hasEnrolledFactors,
          disabled: user.disabled,
          emailVerified: user.emailVerified
        });
      }
    }

    pageToken = listResult.pageToken;
  } while (pageToken && totalUsers < MAX_USERS_TO_SCAN);

  recentUsersBuffer.sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));

  await Promise.all([
    FirebaseMetric.create({
      serviceId: service._id,
      timestamp: now,
      auth: {
        totalUsers,
        activeUsersDaily,
        activeUsersMonthly,
        newSignups24h,
        disabledUsers,
        emailVerifiedCount,
        mfaEnrolledCount,
        anonymousUsers,
        recentSignIns1h
      },
      providers
    }),

    FirebaseAuthSnapshot.findOneAndUpdate(
      { serviceId: service._id },
      {
        lastCheck: now,
        recentUsers: recentUsersBuffer.slice(0, 50)
      },
      { upsert: true }
    )
  ]);
}

async function pollFirebaseProjects(): Promise<void> {
  const now = Date.now();

  const dueServices = await FirebaseService.find({
    $or: [
      { lastCheck: { $exists: false } },
      { lastCheck: null },
      { $expr: { $lte: ['$lastCheck', new Date(now - 60_000)] } }
    ]
  })
    .sort({ lastCheck: 1 })
    .limit(BATCH_SIZE)
    .lean();

  const actuallyDue = dueServices.filter(s => {
    if (!s.lastCheck) return true;
    return now - new Date(s.lastCheck).getTime() >= s.interval * 60_000;
  });

  for (const service of actuallyDue) {
    try {
      await withTimeout(
        processFirebaseProject(service as unknown as IFirebaseService),
        PROCESSOR_TIMEOUT_MS
      );

      await FirebaseService.updateOne(
        { _id: service._id },
        { status: 'online', lastCheck: new Date(), errorMessage: undefined }
      );
    } catch (err: any) {
      const msg = err?.message || 'Unknown error';
      logger.error(`[Firebase Worker] Error processing ${service.name}: ${msg}`);

      removeApp(service._id.toString());

      await FirebaseService.updateOne(
        { _id: service._id },
        { status: 'error', lastCheck: new Date(), errorMessage: msg }
      );
    }
  }
}

async function cleanupPool(): Promise<void> {
  const activeIds = await FirebaseService.find({}).select('_id').lean();
  const activeIdSet = new Set(activeIds.map(s => s._id.toString()));

  for (const [id] of appPool) {
    if (!activeIdSet.has(id)) {
      removeApp(id);
    }
  }
}

export function startFirebaseWorker(): void {
  cron.schedule('* * * * *', async () => {
    try {
      await pollFirebaseProjects();
    } catch (err) {
      logger.error('[Firebase Worker] Poll cycle error:', err);
    }
  }, { name: 'firebase-monitoring-schedule' });

  cron.schedule('0 * * * *', async () => {
    try {
      await cleanupPool();
    } catch (err) {
      logger.error('[Firebase Worker] Pool cleanup error:', err);
    }
  }, { name: 'firebase-pool-cleanup' });

  logger.info('[Firebase Worker] Started');
}
