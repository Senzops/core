import crypto from 'crypto';
import { Resend } from 'resend';
import { logger } from '../utils/logger';

const resend = new Resend(process.env.RESEND_API_KEY);

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

const SEVERITY_CONFIG: Record<string, { color: string; emoji: string; label: string }> = {
  critical: { color: '#ef4444', emoji: '🔴', label: 'CRITICAL' },
  high: { color: '#f97316', emoji: '🟠', label: 'HIGH' },
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
    ? `<tr><td style="padding:5px 0;color:#71717a;vertical-align:top;">Labels</td><td style="padding:5px 0;">${incident.labels.map((l: string) => `<span style="display:inline-block;background:#27272a;color:#a1a1aa;padding:2px 8px;border-radius:6px;font-size:11px;font-family:monospace;margin-right:4px;">${l}</span>`).join('')}</td></tr>`
    : '';

  const descriptionHtml = condition.description
    ? `<p style="color:#71717a;font-size:13px;margin:4px 0 0 0;line-height:1.5;">${condition.description}</p>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#0a0a0b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0b;padding:40px 0;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background-color:#111113;border:1px solid #1e1e21;border-radius:12px;overflow:hidden;">
  <tr>
    <td style="padding:16px 24px;border-bottom:1px solid #1e1e21;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td><span style="color:#fafafa;font-size:16px;font-weight:700;letter-spacing:-0.5px;">Senzor</span></td>
          ${incidentNum ? `<td align="right"><span style="color:#52525b;font-size:11px;font-family:monospace;">${incidentNum}</span></td>` : ''}
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:12px 24px;border-bottom:1px solid #1e1e21;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td><span style="display:inline-block;background:${statusColor};color:#fff;padding:3px 10px;border-radius:6px;font-size:10px;font-weight:700;letter-spacing:0.5px;">${statusText}</span></td>
          <td align="right"><span style="display:inline-block;background:#27272a;color:#a1a1aa;padding:3px 10px;border-radius:6px;font-size:10px;font-weight:700;letter-spacing:0.5px;">${sevConfig.label}</span></td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:24px;">
      <h2 style="color:#fafafa;margin:0 0 4px;font-size:17px;font-weight:700;line-height:1.4;">${condition.name}</h2>
      ${descriptionHtml}
      <p style="color:#52525b;font-size:12px;margin:6px 0 20px;">Policy: <strong style="color:#a1a1aa;">${policy.name}</strong></p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#18181b;border:1px solid #27272a;border-radius:8px;">
        <tr><td style="padding:14px 16px;">
          <table width="100%" style="font-size:13px;border-collapse:collapse;">
            <tr>
              <td style="padding:5px 0;color:#71717a;width:120px;">Target</td>
              <td style="padding:5px 0;color:#fafafa;font-weight:600;">${condition.target.toUpperCase()}</td>
            </tr>
            <tr>
              <td style="padding:5px 0;color:#71717a;">Trigger Value</td>
              <td style="padding:5px 0;color:#fafafa;font-weight:700;font-family:monospace;font-size:14px;">${incident.triggerValue}</td>
            </tr>
            <tr>
              <td style="padding:5px 0;color:#71717a;">Threshold</td>
              <td style="padding:5px 0;color:#a1a1aa;font-family:monospace;">count ${opSymbol} ${condition.threshold.value} in ${condition.threshold.windowMins}m</td>
            </tr>
            <tr>
              <td style="padding:5px 0;color:#71717a;">Time</td>
              <td style="padding:5px 0;color:#a1a1aa;">${time}</td>
            </tr>
            ${duration ? `<tr><td style="padding:5px 0;color:#71717a;">Duration</td><td style="padding:5px 0;color:#10b981;font-weight:600;">${duration}</td></tr>` : ''}
            ${labelsHtml}
          </table>
        </td></tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:24px;">
        <tr>
          <td style="background:#fafafa;border-radius:8px;">
            <a href="${dashboardUrl}" style="display:inline-block;color:#18181b;text-decoration:none;padding:10px 24px;font-weight:600;font-size:13px;">View Incident</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="border-top:1px solid #1e1e21;padding:16px 24px;">
      <p style="color:#52525b;font-size:11px;margin:0;line-height:1.6;">
        Sent by <strong style="color:#a1a1aa;">Senzor</strong> for policy "${policy.name}"
        <br/>Manage notifications at <a href="https://senzor.dev/dashboard/alerts" style="color:#71717a;text-decoration:underline;">senzor.dev/dashboard/alerts</a>
      </p>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;

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

  blocks.push(
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View Incident', emoji: true },
          style: isResolved ? undefined : 'danger',
          url: dashboardUrl
        }
      ]
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `_Senzor · ${policy.name}_` }
      ]
    }
  );

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
        footer: { text: `Senzor · ${policy.name}` }
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

// ============================================================================
// AI ANALYSIS FOLLOW-UP NOTIFICATIONS
// ============================================================================

/**
 * Dispatches a follow-up notification with AI analysis results.
 * Sent after the initial alert, only when analysis completes successfully.
 */
export const dispatchAnalysisUpdate = async (
  destinations: any[],
  incident: any,
  analysis: any,
  policy: any
) => {
  const results = await Promise.allSettled(
    destinations.map((dest: any) => {
      switch (dest.type) {
        case 'email':
          if (dest.config?.emails?.length > 0) {
            return withRetry(
              () => sendAnalysisEmail(dest.config.emails, incident, analysis, policy),
              `Analysis email to ${dest.name}`
            );
          }
          return Promise.resolve();
        case 'slack':
          if (dest.config?.webhookUrl) {
            return withRetry(
              () => sendAnalysisSlack(dest.config.webhookUrl, incident, analysis, policy),
              `Analysis Slack to ${dest.name}`
            );
          }
          return Promise.resolve();
        case 'discord':
          if (dest.config?.webhookUrl) {
            return withRetry(
              () => sendAnalysisDiscord(dest.config.webhookUrl, incident, analysis, policy),
              `Analysis Discord to ${dest.name}`
            );
          }
          return Promise.resolve();
        case 'webhook':
          if (dest.config?.webhookUrl) {
            return withRetry(
              () => sendAnalysisWebhook(dest, incident, analysis, policy),
              `Analysis webhook to ${dest.name}`
            );
          }
          return Promise.resolve();
        default:
          return Promise.resolve();
      }
    })
  );

  const failures = results.filter(r => r.status === 'rejected');
  if (failures.length > 0) {
    logger.warn(`[AI Analysis] ${failures.length}/${results.length} follow-up notification(s) failed for incident ${incident._id}`);
  }
};

// --- Analysis Email ---
const sendAnalysisEmail = async (emails: string[], incident: any, analysis: any, policy: any) => {
  const incidentNum = incident.incidentNumber ? `INC-${String(incident.incidentNumber).padStart(4, '0')}` : '';
  const dashboardUrl = `https://senzor.dev/dashboard/incidents/${incident._id}`;

  const confidenceColor: Record<string, string> = { high: '#10b981', medium: '#f59e0b', low: '#6b7280' };
  const confColor = confidenceColor[analysis.confidence] || '#6b7280';

  const servicesHtml = analysis.findings.affectedServices.length > 0
    ? analysis.findings.affectedServices.map((s: string) =>
        `<span style="display:inline-block;background:#27272a;color:#a1a1aa;padding:2px 8px;border-radius:6px;font-size:11px;font-family:monospace;margin-right:4px;margin-bottom:4px;">${s}</span>`
      ).join('')
    : '';

  const actionsHtml = analysis.findings.recommendedActions.length > 0
    ? analysis.findings.recommendedActions.map((a: string) =>
        `<li style="margin-bottom:6px;color:#a1a1aa;">${a}</li>`
      ).join('')
    : '';

  const correlatedHtml = analysis.findings.correlatedEvents?.length > 0
    ? analysis.findings.correlatedEvents.map((e: string) =>
        `<li style="margin-bottom:4px;color:#a1a1aa;">${e}</li>`
      ).join('')
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#0a0a0b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0b;padding:40px 0;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background-color:#111113;border:1px solid #1e1e21;border-radius:12px;overflow:hidden;">
  <tr>
    <td style="padding:16px 24px;border-bottom:1px solid #1e1e21;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td><span style="color:#fafafa;font-size:16px;font-weight:700;letter-spacing:-0.5px;">Senzor</span></td>
          ${incidentNum ? `<td align="right"><span style="color:#52525b;font-size:11px;font-family:monospace;">${incidentNum}</span></td>` : ''}
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:12px 24px;border-bottom:1px solid #1e1e21;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td><span style="display:inline-block;background:#27272a;color:#a1a1aa;padding:3px 10px;border-radius:6px;font-size:10px;font-weight:700;letter-spacing:0.5px;">AI ANALYSIS</span></td>
          <td align="right"><span style="display:inline-block;background:${confColor};color:#fff;padding:3px 10px;border-radius:6px;font-size:10px;font-weight:700;letter-spacing:0.5px;">${analysis.confidence.toUpperCase()}</span></td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:24px;">
      <p style="color:#52525b;font-size:12px;margin:0 0 16px;">
        ${incident.title} &middot; Policy: <strong style="color:#a1a1aa;">${policy.name}</strong>
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#18181b;border:1px solid #27272a;border-left:3px solid ${confColor};border-radius:0 8px 8px 0;margin-bottom:24px;">
        <tr><td style="padding:16px;">
          <p style="color:#fafafa;font-size:14px;margin:0;line-height:1.6;">${analysis.summary}</p>
        </td></tr>
      </table>
      ${analysis.findings.rootCause ? `
        <p style="color:#a1a1aa;font-size:11px;font-weight:700;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.5px;">Root Cause</p>
        <p style="color:#a1a1aa;font-size:13px;line-height:1.6;margin:0 0 24px;">${analysis.findings.rootCause}</p>
      ` : ''}
      ${servicesHtml ? `
        <p style="color:#a1a1aa;font-size:11px;font-weight:700;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.5px;">Affected Services</p>
        <div style="margin-bottom:24px;">${servicesHtml}</div>
      ` : ''}
      ${correlatedHtml ? `
        <p style="color:#a1a1aa;font-size:11px;font-weight:700;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.5px;">Correlated Events</p>
        <ul style="padding-left:18px;margin:0 0 24px;font-size:13px;line-height:1.7;">${correlatedHtml}</ul>
      ` : ''}
      ${actionsHtml ? `
        <p style="color:#a1a1aa;font-size:11px;font-weight:700;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.5px;">Recommended Actions</p>
        <ol style="padding-left:20px;margin:0 0 24px;font-size:13px;line-height:1.7;">${actionsHtml}</ol>
      ` : ''}
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:4px;">
        <tr>
          <td style="background:#fafafa;border-radius:8px;">
            <a href="${dashboardUrl}" style="display:inline-block;color:#18181b;text-decoration:none;padding:10px 24px;font-weight:600;font-size:13px;">View Incident</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="border-top:1px solid #1e1e21;padding:16px 24px;">
      <p style="color:#52525b;font-size:11px;margin:0;line-height:1.6;">
        AI-generated analysis by <strong style="color:#a1a1aa;">Senzor</strong> for policy "${policy.name}"
        <br/>Automated analysis. Always verify before taking action.
        <br/>Manage notifications at <a href="https://senzor.dev/dashboard/alerts" style="color:#71717a;text-decoration:underline;">senzor.dev/dashboard/alerts</a>
      </p>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  await resend.emails.send({
    from: `Senzor Alerts <${process.env.RESEND_FROM_EMAIL || 'alerts@senzor.dev'}>`,
    to: emails,
    subject: `AI Analysis — ${incidentNum ? `${incidentNum} ` : ''}${incident.title}`,
    html,
  });

  logger.info(`[AI Analysis] Email dispatched for incident ${incident._id}`);
};

// --- Analysis Slack ---
const sendAnalysisSlack = async (webhookUrl: string, incident: any, analysis: any, policy: any) => {
  const incidentNum = incident.incidentNumber ? `INC-${String(incident.incidentNumber).padStart(4, '0')}` : '';
  const dashboardUrl = `https://senzor.dev/dashboard/incidents/${incident._id}`;
  const confEmoji: Record<string, string> = { high: '🟢', medium: '🟡', low: '⚪' };

  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🔍 AI Analysis: ${incident.title?.substring(0, 110)}`, emoji: true },
    },
  ];

  // Description context
  if (incidentNum) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${incidentNum} · Policy: ${policy.name}` }],
    });
  }

  blocks.push({ type: 'divider' });

  // Summary
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `> ${analysis.summary}` },
  });

  // Confidence + Incident fields
  blocks.push({
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: `*Confidence*\n${confEmoji[analysis.confidence] || '⚪'} ${analysis.confidence.toUpperCase()}` },
      { type: 'mrkdwn', text: `*Affected Services*\n${analysis.findings.affectedServices.length > 0 ? analysis.findings.affectedServices.map((s: string) => `\`${s}\``).join(' ') : 'None identified'}` },
    ],
  });

  // Root Cause
  if (analysis.findings.rootCause) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Root Cause*\n${analysis.findings.rootCause}` },
    });
  }

  // Correlated Events
  if (analysis.findings.correlatedEvents?.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Correlated Events*\n${analysis.findings.correlatedEvents.map((e: string) => `• ${e}`).join('\n')}`,
      },
    });
  }

  // Recommended Actions
  if (analysis.findings.recommendedActions.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Recommended Actions*\n${analysis.findings.recommendedActions.map((a: string, i: number) => `${i + 1}. ${a}`).join('\n')}`,
      },
    });
  }

  blocks.push(
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: '_AI-generated by Senzor · Always verify before acting_' },
      ],
    },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'View Incident', emoji: true },
        url: dashboardUrl,
      }],
    }
  );

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `[Senzor] AI Analysis for ${incidentNum || 'incident'}: ${analysis.summary.substring(0, 200)}`,
      blocks,
    }),
  });

  if (!response.ok) throw new Error(`Slack API responded with ${response.status}`);
  logger.info(`[AI Analysis] Slack dispatched for incident ${incident._id}`);
};

// --- Analysis Discord ---
const sendAnalysisDiscord = async (webhookUrl: string, incident: any, analysis: any, policy: any) => {
  const incidentNum = incident.incidentNumber ? `INC-${String(incident.incidentNumber).padStart(4, '0')}` : '';
  const dashboardUrl = `https://senzor.dev/dashboard/incidents/${incident._id}`;

  const confidenceEmoji: Record<string, string> = { high: '🟢', medium: '🟡', low: '⚪' };

  const fields: any[] = [
    { name: 'Incident', value: incidentNum || 'N/A', inline: true },
    { name: 'Confidence', value: `${confidenceEmoji[analysis.confidence] || '⚪'} ${analysis.confidence.toUpperCase()}`, inline: true },
    { name: 'Policy', value: policy.name, inline: true },
  ];

  if (analysis.findings.rootCause) {
    fields.push({ name: 'Root Cause', value: analysis.findings.rootCause.substring(0, 1024), inline: false });
  }

  if (analysis.findings.affectedServices.length > 0) {
    fields.push({ name: 'Affected Services', value: analysis.findings.affectedServices.map((s: string) => `\`${s}\``).join(', '), inline: false });
  }

  if (analysis.findings.correlatedEvents?.length > 0) {
    fields.push({
      name: 'Correlated Events',
      value: analysis.findings.correlatedEvents.map((e: string) => `• ${e}`).join('\n').substring(0, 1024),
      inline: false,
    });
  }

  if (analysis.findings.recommendedActions.length > 0) {
    fields.push({
      name: 'Recommended Actions',
      value: analysis.findings.recommendedActions.map((a: string, i: number) => `${i + 1}. ${a}`).join('\n').substring(0, 1024),
      inline: false,
    });
  }

  const payload = {
    embeds: [{
      title: `🔍 AI Analysis: ${incident.title?.substring(0, 200)}`,
      url: dashboardUrl,
      color: 4144966,
      description: analysis.summary,
      fields,
      footer: { text: `Senzor · AI-generated · Always verify before acting` },
      timestamp: new Date().toISOString(),
    }],
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) throw new Error(`Discord API responded with ${response.status}`);
  logger.info(`[AI Analysis] Discord dispatched for incident ${incident._id}`);
};

// --- Analysis Webhook ---
const sendAnalysisWebhook = async (destination: any, incident: any, analysis: any, policy: any) => {
  const { webhookUrl, method = 'POST', headers: customHeaders = {}, secret } = destination.config;

  const payload = {
    event: 'incident.analysis_completed',
    incident: {
      id: incident._id,
      number: incident.incidentNumber,
      title: incident.title,
      severity: incident.severity,
      status: incident.status,
    },
    analysis: {
      summary: analysis.summary,
      rootCause: analysis.findings.rootCause,
      affectedServices: analysis.findings.affectedServices,
      correlatedEvents: analysis.findings.correlatedEvents,
      recommendedActions: analysis.findings.recommendedActions,
      confidence: analysis.confidence,
      model: analysis.model,
      analyzedAt: analysis.analyzedAt,
    },
    policy: { id: policy._id, name: policy.name },
    timestamp: new Date().toISOString(),
  };

  const body = JSON.stringify(payload);
  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Senzor-AI-Analysis/1.0',
    ...customHeaders,
  };

  if (secret) {
    const signature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');
    reqHeaders['X-Senzor-Signature'] = `sha256=${signature}`;
  }

  const response = await fetch(webhookUrl, { method: method || 'POST', headers: reqHeaders, body });
  if (!response.ok) throw new Error(`Webhook responded with ${response.status}`);
  logger.info(`[AI Analysis] Webhook dispatched for incident ${incident._id}`);
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
