import crypto from 'crypto';
import { Request, Response } from 'express';
import admin from 'firebase-admin';
import { OtpCode } from '../../models/OtpCode';
import { AuthSession } from '../../models/AuthSession';
import { sendOtpEmail } from '../../services/email';
import { markVerified, invalidateUserSessions } from '../../services/authSessionCache';
import { logger } from '../../utils/logger';

// ============================================================================
// Login OTP — issue, inspect, redeem.
// ----------------------------------------------------------------------------
// Redeeming a code writes an AuthSession, which is the ONLY thing the API
// treats as proof of second-factor completion. See models/AuthSession.ts.
// ============================================================================

const OTP_LENGTH = 6;
const CODE_TTL_MS = 5 * 60 * 1000;
/** Rows outlive the send window so the per-account cap can actually count them. */
const ROW_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
const SEND_WINDOW_MS = 60 * 60 * 1000;
const MAX_SENDS_PER_WINDOW = 5;
/** Absolute life of a verified session, independent of Firebase token refresh. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const OTP_CODE_PATTERN = /^\d{6}$/;

/**
 * Codes are peppered with a server-held secret so a database dump alone cannot
 * be brute-forced — a bare SHA-256 over a 10^6 keyspace is reversible in
 * milliseconds. Falls back to the deployment encryption key so existing
 * environments keep working without a new variable; set OTP_PEPPER to rotate
 * the OTP domain independently.
 */
const OTP_PEPPER =
  process.env.OTP_PEPPER ||
  process.env.ENCRYPTION_KEY ||
  'senzor-dev-otp-pepper-do-not-use-in-production';

if (!process.env.OTP_PEPPER && !process.env.ENCRYPTION_KEY && process.env.NODE_ENV === 'production') {
  logger.error('[Auth] OTP_PEPPER and ENCRYPTION_KEY are both unset in production - OTP hashes use a public development pepper.');
}

/**
 * Uniformly distributed numeric code. Rejection sampling, not modulo: 2^32 is
 * not a multiple of 10^6, so `randomUInt32 % 10^6` biases the low end of the
 * range and shrinks the effective keyspace.
 */
function generateOtp(): string {
  const bound = 10 ** OTP_LENGTH;
  const limit = Math.floor(0xffffffff / bound) * bound;
  let value: number;
  do {
    value = crypto.randomBytes(4).readUInt32BE(0);
  } while (value >= limit);
  return (value % bound).toString().padStart(OTP_LENGTH, '0');
}

/** Account-bound so a hash stolen from one row cannot be replayed against another. */
function hashOtp(uid: string, code: string): string {
  return crypto.createHmac('sha256', OTP_PEPPER).update(uid + ':' + code).digest('hex');
}

function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Fixed-width mask: confirms the address without leaking local-part length. */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '••••';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return local.slice(0, Math.min(2, local.length)) + '••••' + domain;
}

const hashUa = (ua?: string) =>
  ua ? crypto.createHash('sha256').update(ua).digest('hex').slice(0, 32) : undefined;

interface AuthContext {
  uid: string;
  email: string;
  /** Firebase `auth_time` (epoch seconds). Normalised to 0 when absent so the
   *  issue path and the gate agree on the key and can never disagree into a loop. */
  authTime: number;
}

function contextOf(req: Request): AuthContext | null {
  const user = (req as any).user;
  if (!user?.uid || !user?.email) return null;
  return { uid: user.uid, email: user.email, authTime: Number(user.auth_time) || 0 };
}

/** Client-facing view of the live code, with no material that aids guessing. */
function describeCode(row: { createdAt: Date; codeExpiresAt: Date; attempts: number }) {
  return {
    expiresAt: row.codeExpiresAt.toISOString(),
    expiresInSeconds: Math.max(0, Math.round((row.codeExpiresAt.getTime() - Date.now()) / 1000)),
    canResendAt: new Date(row.createdAt.getTime() + RESEND_COOLDOWN_MS).toISOString(),
    resendInSeconds: Math.max(
      0,
      Math.ceil((row.createdAt.getTime() + RESEND_COOLDOWN_MS - Date.now()) / 1000)
    ),
    attemptsRemaining: Math.max(0, MAX_ATTEMPTS - row.attempts),
  };
}

// ---------------------------------------------------------------------------
// GET /api/auth/otp/status
// Lets the verification page render truthful timers after a reload and decide
// whether it needs to request a code at all.
// ---------------------------------------------------------------------------
export const getOtpStatus = async (req: Request, res: Response) => {
  try {
    // Demo sessions carry no second factor and are read-only by design.
    if ((req as any).user?.isDemo) {
      return res.json({ verified: true, isDemo: true, code: null, maskedEmail: '' });
    }

    const ctx = contextOf(req);
    if (!ctx) return res.status(401).json({ error: 'Missing authentication context.' });

    const now = new Date();

    const [session, activeCode] = await Promise.all([
      AuthSession.findOne({ uid: ctx.uid, authTime: ctx.authTime, expiresAt: { $gt: now } })
        .select('expiresAt verifiedAt')
        .lean(),
      OtpCode.findOne({ uid: ctx.uid, status: 'active', codeExpiresAt: { $gt: now } })
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    res.json({
      verified: !!session,
      verifiedAt: session?.verifiedAt ?? null,
      sessionExpiresAt: session?.expiresAt ?? null,
      maskedEmail: maskEmail(ctx.email),
      code: activeCode ? describeCode(activeCode as any) : null,
      policy: {
        codeLength: OTP_LENGTH,
        maxAttempts: MAX_ATTEMPTS,
        resendCooldownSeconds: RESEND_COOLDOWN_MS / 1000,
      },
    });
  } catch (error: any) {
    logger.error(`[Auth] OTP status failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to load verification status.' });
  }
};

// ---------------------------------------------------------------------------
// POST /api/auth/otp/send
// Idempotent inside the resend cooldown: a live, recently-issued code is
// returned as-is rather than reissued. That is what makes it safe for the page
// to request a code on mount — a double mount, a retry, or a second tab cannot
// invalidate the code the user is already reading in their inbox.
// ---------------------------------------------------------------------------
export const sendOtp = async (req: Request, res: Response) => {
  try {
    const ctx = contextOf(req);
    if (!ctx) return res.status(401).json({ error: 'Missing authentication context.' });

    const now = new Date();

    const live = await OtpCode.findOne({
      uid: ctx.uid,
      status: 'active',
      codeExpiresAt: { $gt: now },
    }).sort({ createdAt: -1 });

    if (live && now.getTime() - live.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      return res.json({
        message: 'A verification code is already on its way.',
        reused: true,
        ...describeCode(live),
      });
    }

    // Delivery failures are excluded: a provider outage must not consume the
    // hourly budget and lock a user out of their own account.
    const rateFilter = {
      uid: ctx.uid,
      status: { $ne: 'failed' as const },
      createdAt: { $gte: new Date(now.getTime() - SEND_WINDOW_MS) },
    };
    const sendsInWindow = await OtpCode.countDocuments(rateFilter);

    if (sendsInWindow >= MAX_SENDS_PER_WINDOW) {
      const oldest = await OtpCode.findOne(rateFilter)
        .sort({ createdAt: 1 })
        .select('createdAt')
        .lean();

      const retryAfterSeconds = oldest
        ? Math.max(1, Math.ceil((oldest.createdAt.getTime() + SEND_WINDOW_MS - now.getTime()) / 1000))
        : Math.ceil(SEND_WINDOW_MS / 1000);

      logger.warn(`[Auth] OTP send cap reached for ${ctx.uid}`);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error: 'Too many verification codes requested. Please try again later.',
        code: 'SEND_RATE_LIMITED',
        retryAfterSeconds,
      });
    }

    // Any earlier live code stops being redeemable the moment a new one is cut,
    // so two valid codes never coexist.
    await OtpCode.updateMany(
      { uid: ctx.uid, status: 'active' },
      { $set: { status: 'superseded' } }
    );

    const code = generateOtp();
    const row = await OtpCode.create({
      uid: ctx.uid,
      email: ctx.email,
      codeHash: hashOtp(ctx.uid, code),
      status: 'active',
      codeExpiresAt: new Date(now.getTime() + CODE_TTL_MS),
      expiresAt: new Date(now.getTime() + ROW_TTL_MS),
      ip: req.ip,
      uaHash: hashUa(req.headers['user-agent'] as string | undefined),
    });

    try {
      await sendOtpEmail(ctx.email, code);
    } catch (mailError: any) {
      // Retire the unusable code and mark the attempt as not the user's fault.
      await OtpCode.updateOne({ _id: row._id }, { $set: { status: 'failed' } }).catch(() => {});
      logger.error(`[Auth] OTP delivery failed for ${ctx.uid}: ${mailError.message}`);
      return res.status(502).json({
        error: 'We could not send the verification email. Please try again.',
        code: 'DELIVERY_FAILED',
      });
    }

    logger.info(`[Auth] OTP issued for ${ctx.uid}`);
    res.json({ message: 'Verification code sent.', reused: false, ...describeCode(row) });
  } catch (error: any) {
    logger.error(`[Auth] Send OTP failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to send verification code.' });
  }
};

// ---------------------------------------------------------------------------
// POST /api/auth/otp/verify
// ---------------------------------------------------------------------------
export const verifyOtp = async (req: Request, res: Response) => {
  try {
    const ctx = contextOf(req);
    if (!ctx) return res.status(401).json({ error: 'Missing authentication context.' });

    const { code } = req.body;
    if (typeof code !== 'string' || !OTP_CODE_PATTERN.test(code)) {
      return res.status(400).json({ error: 'Invalid verification code format.', code: 'BAD_FORMAT' });
    }

    const now = new Date();

    const candidate = await OtpCode.findOne({ uid: ctx.uid, status: 'active' })
      .sort({ createdAt: -1 })
      .select('_id codeExpiresAt')
      .lean();

    if (!candidate) {
      return res.status(400).json({
        error: 'No verification code found. Please request a new one.',
        code: 'NO_ACTIVE_CODE',
      });
    }

    if (!candidate.codeExpiresAt || candidate.codeExpiresAt <= now) {
      await OtpCode.updateOne({ _id: candidate._id }, { $set: { status: 'superseded' } });
      return res.status(410).json({
        error: 'Verification code has expired. Please request a new one.',
        code: 'EXPIRED',
      });
    }

    // Claim one attempt atomically. Concurrent guesses each consume their own
    // slot instead of racing a read-modify-write and sharing a single increment.
    const claimed = await OtpCode.findOneAndUpdate(
      { _id: candidate._id, status: 'active', attempts: { $lt: MAX_ATTEMPTS } },
      { $inc: { attempts: 1 }, $set: { lastAttemptAt: now } },
      { new: true }
    );

    if (!claimed) {
      await OtpCode.updateOne(
        { _id: candidate._id, status: 'active' },
        { $set: { status: 'superseded' } }
      );
      logger.warn(`[Auth] OTP attempts exhausted for ${ctx.uid}`);
      return res.status(429).json({
        error: 'Too many failed attempts. Please request a new code.',
        code: 'TOO_MANY_ATTEMPTS',
      });
    }

    if (!hashesMatch(hashOtp(ctx.uid, code), claimed.codeHash)) {
      const attemptsRemaining = Math.max(0, MAX_ATTEMPTS - claimed.attempts);
      if (attemptsRemaining === 0) {
        await OtpCode.updateOne({ _id: claimed._id }, { $set: { status: 'superseded' } });
        logger.warn(`[Auth] OTP attempts exhausted for ${ctx.uid}`);
        return res.status(429).json({
          error: 'Too many failed attempts. Please request a new code.',
          code: 'TOO_MANY_ATTEMPTS',
        });
      }
      return res.status(401).json({
        error: 'Incorrect verification code.',
        code: 'INCORRECT',
        attemptsRemaining,
      });
    }

    // Single-use: only the request that flips active -> consumed may proceed.
    const consumed = await OtpCode.updateOne(
      { _id: claimed._id, status: 'active' },
      { $set: { status: 'consumed', consumedAt: now } }
    );

    if (consumed.modifiedCount === 0) {
      return res.status(409).json({
        error: 'This code has already been used. Please request a new one.',
        code: 'ALREADY_USED',
      });
    }

    const sessionExpiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await AuthSession.findOneAndUpdate(
      { uid: ctx.uid, authTime: ctx.authTime },
      {
        $set: {
          email: ctx.email,
          verifiedAt: now,
          expiresAt: sessionExpiresAt,
          ip: req.ip,
          uaHash: hashUa(req.headers['user-agent'] as string | undefined),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    markVerified(ctx.uid, ctx.authTime, sessionExpiresAt);

    logger.info(`[Auth] OTP verified for ${ctx.uid}`);
    res.json({ verified: true, sessionExpiresAt: sessionExpiresAt.toISOString() });
  } catch (error: any) {
    logger.error(`[Auth] Verify OTP failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to verify code.' });
  }
};

// ---------------------------------------------------------------------------
// GET /api/auth/session
// The frontend source of truth for "am I past the second factor?".
// ---------------------------------------------------------------------------
export const getAuthSession = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.uid) return res.status(401).json({ error: 'Missing authentication context.' });

    // Demo sessions carry no second factor and are read-only by design.
    if (user.isDemo) {
      return res.json({ verified: true, isDemo: true, sessionExpiresAt: null });
    }

    const ctx = contextOf(req);
    if (!ctx) return res.status(401).json({ error: 'Missing authentication context.' });

    const session = await AuthSession.findOne({
      uid: ctx.uid,
      authTime: ctx.authTime,
      expiresAt: { $gt: new Date() },
    }).select('expiresAt verifiedAt').lean();

    res.json({
      verified: !!session,
      isDemo: false,
      verifiedAt: session?.verifiedAt ?? null,
      sessionExpiresAt: session?.expiresAt ?? null,
    });
  } catch (error: any) {
    logger.error(`[Auth] Session read failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to load session.' });
  }
};

// ---------------------------------------------------------------------------
// POST /api/auth/revoke-sessions
// ---------------------------------------------------------------------------
export const revokeSessions = async (req: Request, res: Response) => {
  try {
    const uid = (req as any).user?.uid;
    if (!uid) return res.status(401).json({ error: 'Missing authentication context.' });

    await admin.auth().revokeRefreshTokens(uid);

    // Drop the second-factor proof too, so a surviving token cannot re-enter
    // the API on the strength of an earlier verification.
    await AuthSession.deleteMany({ uid });
    invalidateUserSessions(uid);
    await OtpCode.updateMany({ uid, status: 'active' }, { $set: { status: 'superseded' } });

    logger.info(`[Auth] All sessions revoked for ${uid}`);
    res.json({ revoked: true });
  } catch (error: any) {
    logger.error(`[Auth] Revoke sessions failed for ${(req as any).user?.uid}: ${error.message}`);
    res.status(500).json({ error: 'Failed to revoke sessions.' });
  }
};
