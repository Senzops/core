import { Resend } from 'resend';
import { logger } from '../utils/logger';

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

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
          await sendEmailAlert(destination.config.emails, incident, condition, policy);
        }
        break;
      case 'slack':
        if (destination.config?.webhookUrl) {
          await sendSlackAlert(destination.config.webhookUrl, incident, condition, policy);
        }
        break;
      case 'discord':
        if (destination.config?.webhookUrl) {
          await sendDiscordAlert(destination.config.webhookUrl, incident, condition, policy);
        }
        break;
      default:
        logger.warn(`[Alerts] Unknown destination type: ${destination.type}`);
    }
  } catch (error: any) {
    logger.error(`[Alerts] Failed to dispatch ${destination.type} alert to ${destination.name}: ${error.message}`);
  }
};

// --- 1. Resend Email Transport ---
const sendEmailAlert = async (emails: string[], incident: any, condition: any, policy: any) => {
  const isResolved = incident.status === 'resolved';
  const color = isResolved ? '#10b981' : '#ef4444';
  const statusText = isResolved ? 'RESOLVED' : 'FIRED';
  const time = new Date(isResolved ? incident.resolvedAt : incident.openedAt).toUTCString();
  const dashboardUrl = `https://senzor.dev/dashboard/alerts/${policy._id}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 8px;">
      <h2 style="color: ${color}; margin-top: 0; display: flex; align-items: center;">
        <span style="background-color: ${color}; padding: 4px 8px; border-radius: 4px; color: white; font-size: 12px; margin-right: 10px;">${statusText}</span>
        ${condition.name}
      </h2>
      <p style="color: #666; font-size: 14px;"><strong>Policy:</strong> ${policy.name}</p>
      
      <div style="background-color: #f9fafb; padding: 15px; border-radius: 6px; margin: 20px 0;">
        <h3 style="margin-top: 0; font-size: 14px; color: #333; text-transform: uppercase;">Incident Details</h3>
        <p style="margin: 5px 0; font-size: 14px;"><strong>Target:</strong> ${condition.target.toUpperCase()}</p>
        <p style="margin: 5px 0; font-size: 14px;"><strong>Trigger Value:</strong> ${incident.triggerValue} (Threshold: ${condition.threshold.operator} ${condition.threshold.value})</p>
        <p style="margin: 5px 0; font-size: 14px;"><strong>Time:</strong> ${time}</p>
      </div>

      <div style="background-color: #1e293b; padding: 15px; border-radius: 6px; margin: 20px 0; overflow-x: auto;">
        <h3 style="margin-top: 0; font-size: 12px; color: #94a3b8; text-transform: uppercase;">Condition Query</h3>
        <pre style="color: #e2e8f0; font-size: 12px; margin: 0;">${JSON.stringify(condition.query, null, 2)}</pre>
      </div>

      <a href="${dashboardUrl}" style="display: inline-block; background-color: #3b82f6; color: white; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-weight: bold; font-size: 14px;">
        View Incident in Senzor
      </a>
    </div>
  `;

  await resend.emails.send({
    from: `Senzor Alerts <${process.env.RESEND_FROM_EMAIL || 'alerts@senzor.dev'}>`,
    to: emails,
    subject: `[Senzor] ${statusText}: ${condition.name}`,
    html
  });

  logger.info(`[Alerts] Resend email dispatched for Incident ${incident._id}`);
};

// --- 2. Slack Webhook Transport (Block Kit) ---
const sendSlackAlert = async (webhookUrl: string, incident: any, condition: any, policy: any) => {
  const isResolved = incident.status === 'resolved';
  const statusIcon = isResolved ? '✅' : '🚨';
  const time = new Date(isResolved ? incident.resolvedAt : incident.openedAt).toUTCString();
  const dashboardUrl = `https://senzor.dev/dashboard/alerts/${policy._id}`;

  const payload = {
    text: `[Senzor Alert] ${condition.name}`, // Fallback text
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `${statusIcon} ${isResolved ? 'RESOLVED' : 'FIRED'}: ${condition.name}`, emoji: true }
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Policy:*\n${policy.name}` },
          { type: "mrkdwn", text: `*Target:*\n${condition.target.toUpperCase()}` },
          { type: "mrkdwn", text: `*Value:*\n${incident.triggerValue} (Threshold: ${condition.threshold.operator} ${condition.threshold.value})` },
          { type: "mrkdwn", text: `*Time:*\n${time}` }
        ]
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Condition Query:*\n\`\`\`${JSON.stringify(condition.query, null, 2)}\`\`\`` }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View Incident in Senzor" },
            style: isResolved ? "primary" : "danger",
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
  logger.info(`[Alerts] Slack webhook dispatched for Incident ${incident._id}`);
};

// --- 3. Discord Webhook Transport (Embeds) ---
const sendDiscordAlert = async (webhookUrl: string, incident: any, condition: any, policy: any) => {
  const isResolved = incident.status === 'resolved';
  const color = isResolved ? 1095945 : 15680580; // Decimal colors for Emerald and Red
  const time = new Date(isResolved ? incident.resolvedAt : incident.openedAt).toISOString();
  const dashboardUrl = `https://senzor.dev/dashboard/alerts/${policy._id}`;

  const payload = {
    embeds: [
      {
        title: `${isResolved ? '✅ RESOLVED' : '🚨 FIRED'}: ${condition.name}`,
        url: dashboardUrl,
        color: color,
        fields: [
          { name: "Policy", value: policy.name, inline: true },
          { name: "Target", value: condition.target.toUpperCase(), inline: true },
          { name: "Trigger Value", value: `${incident.triggerValue} (Threshold: ${condition.threshold.operator} ${condition.threshold.value})`, inline: false },
          { name: "Condition Query", value: `\`\`\`json\n${JSON.stringify(condition.query, null, 2)}\n\`\`\``, inline: false }
        ],
        timestamp: time,
        footer: { text: "Senzor Alerting Engine" }
      }
    ]
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) throw new Error(`Discord API responded with ${response.status}`);
  logger.info(`[Alerts] Discord webhook dispatched for Incident ${incident._id}`);
};