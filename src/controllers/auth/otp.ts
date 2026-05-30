import crypto from 'crypto';
import { Request, Response } from 'express';
import { OtpCode } from '../../models/OtpCode';
import { sendOtpEmail } from '../../services/email';
import { logger } from '../../utils/logger';

const OTP_EXPIRY_MINUTES = 5;
const OTP_LENGTH = 6;
const MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MINUTES = 10;
const RATE_LIMIT_MAX_REQUESTS = 3;

function generateOtp(): string {
  const buffer = crypto.randomBytes(4);
  const num = buffer.readUInt32BE(0) % (10 ** OTP_LENGTH);
  return num.toString().padStart(OTP_LENGTH, '0');
}

function hashOtp(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

export const sendOtp = async (req: Request, res: Response) => {
  try {
    const email = (req as any).user?.email;
    if (!email) return res.status(401).json({ error: 'Missing authentication context.' });

    const windowStart = new Date();
    windowStart.setMinutes(windowStart.getMinutes() - RATE_LIMIT_WINDOW_MINUTES);

    const recentCount = await OtpCode.countDocuments({
      email,
      createdAt: { $gte: windowStart },
    });

    if (recentCount >= RATE_LIMIT_MAX_REQUESTS) {
      return res.status(429).json({
        error: 'Too many verification codes requested. Please try again later.',
      });
    }

    await OtpCode.deleteMany({ email });

    const code = generateOtp();
    const codeHash = hashOtp(code);

    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + OTP_EXPIRY_MINUTES);

    await OtpCode.create({ email, codeHash, expiresAt });
    await sendOtpEmail(email, code);

    logger.info(`[Auth] OTP sent to ${email}`);
    res.json({ message: 'Verification code sent.', expiresInSeconds: OTP_EXPIRY_MINUTES * 60 });
  } catch (error: any) {
    logger.error(`[Auth] Send OTP failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to send verification code.' });
  }
};

export const verifyOtp = async (req: Request, res: Response) => {
  try {
    const email = (req as any).user?.email;
    if (!email) return res.status(401).json({ error: 'Missing authentication context.' });

    const { code } = req.body;
    if (!code || typeof code !== 'string' || code.length !== OTP_LENGTH) {
      return res.status(400).json({ error: 'Invalid verification code format.' });
    }

    const otpRecord = await OtpCode.findOne({ email }).sort({ createdAt: -1 });

    if (!otpRecord) {
      return res.status(400).json({ error: 'No verification code found. Please request a new one.' });
    }

    if (otpRecord.expiresAt < new Date()) {
      await otpRecord.deleteOne();
      return res.status(410).json({ error: 'Verification code has expired. Please request a new one.' });
    }

    if (otpRecord.attempts >= MAX_ATTEMPTS) {
      await otpRecord.deleteOne();
      return res.status(429).json({ error: 'Too many failed attempts. Please request a new code.' });
    }

    const codeHash = hashOtp(code);

    if (codeHash !== otpRecord.codeHash) {
      otpRecord.attempts += 1;
      await otpRecord.save();

      const remaining = MAX_ATTEMPTS - otpRecord.attempts;
      return res.status(401).json({
        error: 'Incorrect verification code.',
        attemptsRemaining: remaining,
      });
    }

    await otpRecord.deleteOne();

    logger.info(`[Auth] OTP verified for ${email}`);
    res.json({ verified: true });
  } catch (error: any) {
    logger.error(`[Auth] Verify OTP failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to verify code.' });
  }
};
