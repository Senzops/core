import { Resend } from 'resend';
import { logger } from '../utils/logger';

let _resend: Resend | null = null;

export const getResendClient = (): Resend => {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
};

const FROM_ADDRESS = () => `Senzor <${process.env.RESEND_FROM_EMAIL || 'noreply@senzor.dev'}>`;

export async function sendOtpEmail(email: string, code: string): Promise<void> {
  const { error } = await getResendClient().emails.send({
    from: FROM_ADDRESS(),
    to: email,
    subject: `${code} is your Senzor verification code`,
    html: buildOtpEmailHtml(code),
  });

  if (error) {
    logger.error(`[Email] Failed to send OTP to ${email}: ${error.message}`);
    throw new Error('Failed to send verification email.');
  }
}

function buildOtpEmailHtml(code: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#0a0a0b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0b;padding:40px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="460" cellpadding="0" cellspacing="0" style="background-color:#111113;border:1px solid #1e1e21;border-radius:12px;padding:40px;">
          <tr>
            <td align="center" style="padding-bottom:24px;">
              <span style="font-size:20px;font-weight:700;color:#fafafa;letter-spacing:-0.5px;">Senzor</span>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-bottom:8px;">
              <span style="font-size:15px;color:#a1a1aa;">Your verification code</span>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-bottom:24px;">
              <div style="font-size:36px;font-weight:700;letter-spacing:8px;color:#fafafa;background-color:#18181b;border:1px solid #27272a;border-radius:8px;padding:16px 32px;display:inline-block;">${code}</div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-bottom:8px;">
              <span style="font-size:13px;color:#71717a;">This code expires in <strong style="color:#a1a1aa;">5 minutes</strong>.</span>
            </td>
          </tr>
          <tr>
            <td align="center">
              <span style="font-size:13px;color:#71717a;">If you didn't request this code, you can safely ignore this email.</span>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:32px;border-top:1px solid #1e1e21;margin-top:24px;">
              <span style="font-size:11px;color:#52525b;">&copy; ${new Date().getFullYear()} Senzor Platforms. All rights reserved.</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
