import crypto from 'crypto';
import { Resend } from 'resend';
import { logger } from '../utils/logger';

const resend = new Resend(process.env.RESEND_API_KEY);

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

const SEVERITY_CONFIG: Record<string, { color: string; emoji: string; label: string }> = {
  critical: { color: '#dc2626', emoji: '🔴', label: 'CRITICAL' },
  high: { color: '#ef4444', emoji: '🟠', label: 'HIGH' },
  medium: { color: '#f59e0b', emoji: '🟡', label: 'MEDIUM' },
  low: { color: '#3b82f6', emoji: '🔵', label: 'LOW' },
  info: { color: '#6b7280', emoji: '⚪', label: 'INFO' },
};

// --- Retry Wrapper ---
const withRetry = async <T>(fn: () => Promise<T>, label: string): Promise<T> => {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn(`[Alerts] ${label} attempt ${attempt} failed, retrying in ${delay}ms: ${err.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
};

// --- Master Dispatcher ---
export const dispatchAlert = async (
  destination: any,
  incident: any,
  condition: any,
  policy: any
) => {
  try {
    switch (destination.type) {
      case 'email':
        if (destination.config?.emails?.length > 0) {
          await withRetry(
            () => sendEmailAlert(destination.config.emails, incident, condition, policy),
            `Email to ${destination.name}`
          );
        }
        break;
      case 'slack':
        if (destination.config?.webhookUrl) {
          await withRetry(
            () => sendSlackAlert(destination.config.webhookUrl, incident, condition, policy),
            `Slack to ${destination.name}`
          );
        }
        break;
      case 'discord':
        if (destination.config?.webhookUrl) {
          await withRetry(
            () => sendDiscordAlert(destination.config.webhookUrl, incident, condition, policy),
            `Discord to ${destination.name}`
          );
        }
        break;
      case 'webhook':
        if (destination.config?.webhookUrl) {
          await withRetry(
            () => sendWebhookAlert(destination, incident, condition, policy),
            `Webhook to ${destination.name}`
          );
        }
        break;
      default:
        logger.warn(`[Alerts] Unknown destination type: ${destination.type}`);
    }
  } catch (error: any) {
    logger.error(`[Alerts] Failed to dispatch ${destination.type} alert to ${destination.name} after ${MAX_RETRIES} attempts: ${error.message}`);
    throw error;
  }
};

// --- Email Transport ---
const sendEmailAlert = async (emails: string[], incident: any, condition: any, policy: any) => {
  const isResolved = incident.status === 'resolved';
  const severity = condition.severity || 'high';
  const sevConfig = SEVERITY_CONFIG[severity] || SEVERITY_CONFIG.high;
  const statusColor = isResolved ? '#10b981' : sevConfig.color;
  const statusText = isResolved ? 'RESOLVED' : 'FIRED';
  const time = new Date(isResolved ? incident.resolvedAt : incident.openedAt).toUTCString();
  const dashboardUrl = `https://senzor.dev/dashboard/incidents/${incident._id}`;
  const incidentNum = incident.incidentNumber ? `INC-${String(incident.incidentNumber).padStart(4, '0')}` : '';

  const duration = isResolved && incident.openedAt && incident.resolvedAt
    ? formatDuration(new Date(incident.openedAt), new Date(incident.resolvedAt))
    : null;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 8px;">
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 16px;">
        <span style="background-color: ${statusColor}; padding: 4px 10px; border-radius: 4px; color: white; font-size: 11px; font-weight: 700; letter-spacing: 0.5px;">${statusText}</span>
        <span style="background-color: ${sevConfig.color}15; color: ${sevConfig.color}; padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 700; letter-spacing: 0.5px;">${sevConfig.label}</span>
        ${incidentNum ? `<span style="color: #6b7280; font-size: 12px; font-family: monospace;">${incidentNum}</span>` : ''}
      </div>

      <h2 style="color: #111; margin: 0 0 4px 0; font-size: 18px;">${condition.name}</h2>
      <p style="color: #666; font-size: 13px; margin: 0 0 20px 0;"><strong>Policy:</strong> ${policy.name}</p>

      <div style="background-color: #f9fafb; padding: 16px; border-radius: 8px; margin: 0 0 20px 0;">
        <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
          <tr><td style="padding: 4px 0; color: #666; width: 120px;">Target</td><td style="padding: 4px 0; font-weight: 600;">${condition.target.toUpperCase()}</td></tr>
          <tr><td style="padding: 4px 0; color: #666;">Trigger Value</td><td style="padding: 4px 0; font-weight: 600;">${incident.triggerValue} (Threshold: ${condition.threshold.operator} ${condition.threshold.value})</td></tr>
          <tr><td style="padding: 4px 0; color: #666;">Window</td><td style="padding: 4px 0;">${condition.threshold.windowMins} minutes</td></tr>
          <tr><td style="padding: 4px 0; color: #666;">Time</td><td style="padding: 4px 0;">${time}</td></tr>
          ${duration ? `<tr><td style="padding: 4px 0; color: #666;">Duration</td><td style="padding: 4px 0;">${duration}</td></tr>` : ''}
        </table>
      </div>

      <div style="background-color: #1e293b; padding: 16px; border-radius: 8px; margin: 0 0 20px 0; overflow-x: auto;">
        <div style="color: #94a3b8; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Condition Query</div>
        <pre style="color: #e2e8f0; font-size: 12px; margin: 0; white-space: pre-wrap; word-break: break-all;">${JSON.stringify(condition.query, null, 2)}</pre>
      </div>

      <a href="${dashboardUrl}" style="display: inline-block; background-color: #3b82f6; color: white; text-decoration: none; padding: 10px 24px; border-radius: 6px; font-weight: 600; font-size: 13px;">
        View Incident
      </a>
    </div>
  `;

  await resend.emails.send({
    from: `Senzor Alerts <${process.env.RESEND_FROM_EMAIL || 'alerts@senzor.dev'}>`,
    to: emails,
    subject: `[Senzor] ${statusText} ${sevConfig.emoji} ${incidentNum ? `${incidentNum}: ` : ''}${condition.name}`,
    html
  });

  logger.info(`[Alerts] Email dispatched for incident ${incident._id}`);
};

// --- Slack Transport ---
const sendSlackAlert = async (webhookUrl: string, incident: any, condition: any, policy: any) => {
  const isResolved = incident.status === 'resolved';
  const severity = condition.severity || 'high';
  const sevConfig = SEVERITY_CONFIG[severity] || SEVERITY_CONFIG.high;
  const statusIcon = isResolved ? '✅' : '🚨';
  const time = new Date(isResolved ? incident.resolvedAt : incident.openedAt).toUTCString();
  const dashboardUrl = `https://senzor.dev/dashboard/incidents/${incident._id}`;
  const incidentNum = incident.incidentNumber ? `INC-${String(incident.incidentNumber).padStart(4, '0')}` : '';

  const payload = {
    text: `[Senzor] ${isResolved ? 'RESOLVED' : 'FIRED'}: ${condition.name}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${statusIcon} ${isResolved ? 'RESOLVED' : 'FIRED'}: ${condition.name}`, emoji: true }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Incident:*\n${incidentNum}` },
          { type: 'mrkdwn', text: `*Severity:*\n${sevConfig.emoji} ${sevConfig.label}` },
          { type: 'mrkdwn', text: `*Policy:*\n${policy.name}` },
          { type: 'mrkdwn', text: `*Target:*\n${condition.target.toUpperCase()}` },
          { type: 'mrkdwn', text: `*Value:*\n${incident.triggerValue} (${condition.threshold.operator} ${condition.threshold.value})` },
          { type: 'mrkdwn', text: `*Time:*\n${time}` }
        ]
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View Incident' },
            style: isResolved ? 'primary' : 'danger',
            url: dashboardUrl
          }
        ]
      }
    ]
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) throw new Error(`Slack API responded with ${response.status}`);
  logger.info(`[Alerts] Slack dispatched for incident ${incident._id}`);
};

// --- Discord Transport ---
const sendDiscordAlert = async (webhookUrl: string, incident: any, condition: any, policy: any) => {
  const isResolved = incident.status === 'resolved';
  const severity = condition.severity || 'high';
  const sevConfig = SEVERITY_CONFIG[severity] || SEVERITY_CONFIG.high;
  const color = isResolved ? 1095945 : parseInt(sevConfig.color.replace('#', ''), 16);
  const time = new Date(isResolved ? incident.resolvedAt : incident.openedAt).toISOString();
  const dashboardUrl = `https://senzor.dev/dashboard/incidents/${incident._id}`;
  const incidentNum = incident.incidentNumber ? `INC-${String(incident.incidentNumber).padStart(4, '0')}` : '';

  const payload = {
    embeds: [
      {
        title: `${isResolved ? '✅ RESOLVED' : '🚨 FIRED'}: ${condition.name}`,
        url: dashboardUrl,
        color,
        fields: [
          { name: 'Incident', value: incidentNum || 'N/A', inline: true },
          { name: 'Severity', value: `${sevConfig.emoji} ${sevConfig.label}`, inline: true },
          { name: 'Policy', value: policy.name, inline: true },
          { name: 'Target', value: condition.target.toUpperCase(), inline: true },
          { name: 'Trigger Value', value: `${incident.triggerValue} (${condition.threshold.operator} ${condition.threshold.value})`, inline: false }
        ],
        timestamp: time,
        footer: { text: 'Senzor Alerting Engine' }
      }
    ]
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) throw new Error(`Discord API responded with ${response.status}`);
  logger.info(`[Alerts] Discord dispatched for incident ${incident._id}`);
};

// --- Generic Webhook Transport ---
const sendWebhookAlert = async (destination: any, incident: any, condition: any, policy: any) => {
  const { webhookUrl, method = 'POST', headers: customHeaders = {}, secret } = destination.config;

  const payload = {
    event: incident.status === 'resolved' ? 'incident.resolved' : 'incident.fired',
    incident: {
      id: incident._id,
      number: incident.incidentNumber,
      title: incident.title,
      severity: incident.severity,
      status: incident.status,
      triggerValue: incident.triggerValue,
      openedAt: incident.openedAt,
      resolvedAt: incident.resolvedAt,
      labels: incident.labels
    },
    condition: {
      id: condition._id,
      name: condition.name,
      target: condition.target,
      threshold: condition.threshold,
      severity: condition.severity
    },
    policy: {
      id: policy._id,
      name: policy.name
    },
    timestamp: new Date().toISOString()
  };

  const body = JSON.stringify(payload);

  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Senzor-Alerting/1.0',
    ...customHeaders
  };

  if (secret) {
    const signature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');
    reqHeaders['X-Senzor-Signature'] = `sha256=${signature}`;
  }

  const response = await fetch(webhookUrl, {
    method: method || 'POST',
    headers: reqHeaders,
    body
  });

  if (!response.ok) throw new Error(`Webhook responded with ${response.status}`);
  logger.info(`[Alerts] Webhook dispatched for incident ${incident._id}`);
};

// --- Utility ---
const formatDuration = (start: Date, end: Date): string => {
  const ms = end.getTime() - start.getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
};
