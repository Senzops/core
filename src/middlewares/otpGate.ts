import { Request, Response, NextFunction } from 'express';
import { isOtpVerified } from '../services/authSessionCache';

// ============================================================================
// requireOtpVerified — enforces Senzor's second factor on the API surface.
// ----------------------------------------------------------------------------
// Before this existed, OTP completion lived only in the browser
// (localStorage['senzor-otp-verified']) and no endpoint consulted it, so the
// second factor was decorative: a valid Firebase token reached every route
// whether or not a code had ever been entered. This middleware makes the
// server the authority.
//
// Mount it AFTER authenticateUser (it needs req.user) and BEFORE workspace
// resolution, so an unverified caller cannot even enumerate org membership.
// ============================================================================

interface OtpGateOptions {
  /**
   * Router-relative paths that must stay reachable before verification.
   * Keep this list minimal and justified — every entry is an unverified-reach
   * hole. Matched exactly against `req.path`.
   */
  exempt?: string[];
}

export const requireOtpVerified = (options: OtpGateOptions = {}) => {
  const exempt = new Set(options.exempt ?? []);

  return async (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;

    // authenticateUser runs first and always populates this; treat absence as a
    // wiring error rather than an implicit pass.
    if (!user?.uid) {
      return res.status(401).json({ error: 'Unauthorized: Missing user context.' });
    }

    // Demo mode has no account to protect and is already restricted to GET.
    if (user.isDemo) return next();

    if (exempt.has(req.path)) return next();

    // Normalised identically to the issue path in controllers/auth/otp.ts, so a
    // token without auth_time still keys consistently and cannot loop.
    const authTime = Number(user.auth_time) || 0;

    if (await isOtpVerified(user.uid, authTime)) return next();

    // 403 + an explicit code: the frontend interceptor keys on this to route to
    // verification instead of burning a token refresh on a non-token problem.
    return res.status(403).json({
      error: 'Verification required. Please confirm the code sent to your email.',
      code: 'OTP_REQUIRED',
    });
  };
};
