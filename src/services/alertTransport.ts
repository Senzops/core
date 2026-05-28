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

const OPERATOR_SYMBOLS: Record<string, string> = {
  gt: '>', lt: '<', eq: '=', gte: '≥', lte: '≤', neq: '≠'
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
  const statusText = isResolved ? 'RESOLVED' : 'FIRING';
  const time = new Date(isResolved ? incident.resolvedAt : incident.openedAt).toUTCString();
  const dashboardUrl = `https://senzor.dev/dashboard/incidents/${incident._id}`;
  const incidentNum = incident.incidentNumber ? `INC-${String(incident.incidentNumber).padStart(4, '0')}` : '';
  const opSymbol = OPERATOR_SYMBOLS[condition.threshold.operator] || condition.threshold.operator;

  const duration = isResolved && incident.openedAt && incident.resolvedAt
    ? formatDuration(new Date(incident.openedAt), new Date(incident.resolvedAt))
    : null;

  const labelsHtml = incident.labels?.length > 0
    ? `<tr><td style="padding: 6px 0; color: #6b7280; vertical-align: top;">Labels</td><td style="padding: 6px 0;">${incident.labels.map((l: string) => `<span style="display: inline-block; background: #f1f5f9; color: #475569; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-family: monospace; margin-right: 4px;">${l}</span>`).join('')}</td></tr>`
    : '';

  const descriptionHtml = condition.description
    ? `<p style="color: #64748b; font-size: 13px; margin: 4px 0 0 0; line-height: 1.5;">${condition.description}</p>`
    : '';

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <!-- Header Bar -->
      <div style="background: ${statusColor}; padding: 16px 24px; border-radius: 8px 8px 0 0;">
        <table style="width: 100%;">
          <tr>
            <td>
              <span style="color: white; font-size: 12px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase;">${statusText}</span>
              ${incidentNum ? `<span style="color: rgba(255,255,255,0.8); font-size: 12px; font-family: monospace; margin-left: 12px;">${incidentNum}</span>` : ''}
            </td>
            <td style="text-align: right;">
              <span style="background: rgba(255,255,255,0.2); color: white; padding: 3px 10px; border-radius: 4px; font-size: 11px; font-weight: 700; letter-spacing: 0.5px;">${sevConfig.label}</span>
            </td>
          </tr>
        </table>
      </div>

      <!-- Body -->
      <div style="border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px; padding: 24px;">
        <h2 style="color: #0f172a; margin: 0 0 4px 0; font-size: 18px; font-weight: 700; line-height: 1.4;">${condition.name}</h2>
        ${descriptionHtml}
        <p style="color: #94a3b8; font-size: 12px; margin: 8px 0 20px 0;">Policy: <strong style="color: #64748b;">${policy.name}</strong></p>

        <!-- Details Table -->
        <div style="background: #f8fafc; padding: 16px; border-radius: 8px; border: 1px solid #e2e8f0;">
          <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
            <tr>
              <td style="padding: 6px 0; color: #6b7280; width: 130px;">Target</td>
              <td style="padding: 6px 0; font-weight: 600; color: #1e293b;">${condition.target.toUpperCase()}</td>
            </tr>
            <tr>
              <td style="padding: 6px 0; color: #6b7280;">Trigger Value</td>
              <td style="padding: 6px 0; font-weight: 700; color: #1e293b; font-family: monospace; font-size: 14px;">${incident.triggerValue}</td>
            </tr>
            <tr>
              <td style="padding: 6px 0; color: #6b7280;">Threshold</td>
              <td style="padding: 6px 0; font-family: monospace; color: #475569;">count ${opSymbol} ${condition.threshold.value} in ${condition.threshold.windowMins}m window</td>
            </tr>
            <tr>
              <td style="padding: 6px 0; color: #6b7280;">Time</td>
              <td style="padding: 6px 0; color: #475569;">${time}</td>
            </tr>
            ${duration ? `<tr><td style="padding: 6px 0; color: #6b7280;">Duration</td><td style="padding: 6px 0; font-weight: 600; color: #10b981;">${duration}</td></tr>` : ''}
            ${labelsHtml}
          </table>
        </div>

        <!-- CTA -->
        <div style="margin-top: 24px;">
          <a href="${dashboardUrl}" style="display: inline-block; background-color: #3b82f6; color: white; text-decoration: none; padding: 10px 28px; border-radius: 6px; font-weight: 600; font-size: 13px;">
            View Incident
          </a>
        </div>

        <!-- Footer -->
        <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0;">
          <p style="color: #94a3b8; font-size: 11px; margin: 0; line-height: 1.5;">
            Sent by <strong>Senzor Alerting Engine</strong> for policy "${policy.name}".
            <br/>Manage alert preferences at <a href="https://senzor.dev/dashboard/alerts" style="color: #3b82f6; text-decoration: none;">senzor.dev/dashboard/alerts</a>
          </p>
        </div>
      </div>
    </div>
  `;

  await resend.emails.send({
    from: `Senzor Alerts <${process.env.RESEND_FROM_EMAIL || 'alerts@senzor.dev'}>`,
    to: emails,
    subject: `${isResolved ? 'Resolved' : 'Firing'} — ${incidentNum ? `${incidentNum} ` : ''}${condition.name} [${sevConfig.label}]`,
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
  const dashboardUrl = `https://senzor.dev/dashboard/incidents/${incident._id}`;
  const incidentNum = incident.incidentNumber ? `INC-${String(incident.incidentNumber).padStart(4, '0')}` : '';
  const opSymbol = OPERATOR_SYMBOLS[condition.threshold.operator] || condition.threshold.operator;
  const timestamp = Math.floor(new Date(isResolved ? incident.resolvedAt : incident.openedAt).getTime() / 1000);

  const duration = isResolved && incident.openedAt && incident.resolvedAt
    ? formatDuration(new Date(incident.openedAt), new Date(incident.resolvedAt))
    : null;

  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${statusIcon} ${isResolved ? 'Resolved' : 'Firing'}: ${condition.name}`, emoji: true }
    },
  ];

  // Description context if available
  if (condition.description) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: condition.description }]
    });
  }

  blocks.push({ type: 'divider' });

  // Main fields
  const fields: any[] = [
    { type: 'mrkdwn', text: `*Incident*\n${incidentNum || 'N/A'}` },
    { type: 'mrkdwn', text: `*Severity*\n${sevConfig.emoji} ${sevConfig.label}` },
    { type: 'mrkdwn', text: `*Policy*\n${policy.name}` },
    { type: 'mrkdwn', text: `*Target*\n${condition.target.toUpperCase()}` },
    { type: 'mrkdwn', text: `*Trigger Value*\n\`${incident.triggerValue}\` (threshold: count ${opSymbol} ${condition.threshold.value})` },
    { type: 'mrkdwn', text: `*Window*\n${condition.threshold.windowMins} minutes` },
  ];

  blocks.push({ type: 'section', fields });

  // Labels + duration context
  const contextElements: any[] = [];

  if (duration) {
    contextElements.push({ type: 'mrkdwn', text: `⏱ Resolved in *${duration}*` });
  }

  if (incident.labels?.length > 0) {
    contextElements.push({ type: 'mrkdwn', text: `🏷 ${incident.labels.map((l: string) => `\`${l}\``).join(' ')}` });
  }

  contextElements.push({ type: 'mrkdwn', text: `<!date^${timestamp}^{date_short_pretty} at {time}|${new Date(isResolved ? incident.resolvedAt : incident.openedAt).toUTCString()}>` });

  if (contextElements.length > 0) {
    blocks.push({ type: 'context', elements: contextElements });
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'View Incident', emoji: true },
        style: isResolved ? undefined : 'danger',
        url: dashboardUrl
      }
    ]
  });

  const payload = {
    text: `[Senzor] ${isResolved ? 'Resolved' : 'Firing'}: ${incidentNum ? `${incidentNum} — ` : ''}${condition.name}`,
    blocks
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
  const opSymbol = OPERATOR_SYMBOLS[condition.threshold.operator] || condition.threshold.operator;

  const duration = isResolved && incident.openedAt && incident.resolvedAt
    ? formatDuration(new Date(incident.openedAt), new Date(incident.resolvedAt))
    : null;

  const fields: any[] = [
    { name: 'Incident', value: incidentNum || 'N/A', inline: true },
    { name: 'Severity', value: `${sevConfig.emoji} ${sevConfig.label}`, inline: true },
    { name: 'Policy', value: policy.name, inline: true },
    { name: 'Target', value: condition.target.toUpperCase(), inline: true },
    { name: 'Trigger Value', value: `\`${incident.triggerValue}\`  (threshold: count ${opSymbol} ${condition.threshold.value})`, inline: false },
    { name: 'Window', value: `${condition.threshold.windowMins} minutes`, inline: true },
  ];

  if (duration) {
    fields.push({ name: 'Duration', value: duration, inline: true });
  }

  if (condition.description) {
    fields.push({ name: 'Description', value: condition.description, inline: false });
  }

  if (incident.labels?.length > 0) {
    fields.push({ name: 'Labels', value: incident.labels.map((l: string) => `\`${l}\``).join(' '), inline: false });
  }

  const payload = {
    embeds: [
      {
        title: `${isResolved ? '✅ Resolved' : '🚨 Firing'}: ${condition.name}`,
        url: dashboardUrl,
        color,
        description: condition.description || undefined,
        fields,
        timestamp: time,
        footer: { text: `Senzor Alerting Engine · ${policy.name}` }
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
      labels: incident.labels || [],
      openedAt: incident.openedAt,
      acknowledgedAt: incident.acknowledgedAt || null,
      resolvedAt: incident.resolvedAt || null
    },
    condition: {
      id: condition._id,
      name: condition.name,
      description: condition.description || null,
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
