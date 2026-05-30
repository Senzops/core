import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { ApmService } from '../../models/Apm';
import { RumService } from '../../models/Rum';
import { TaskService } from '../../models/Task';
import { DatabaseService } from '../../models/Database';
import { Website } from '../../models/Web';
import { Vps } from '../../models/Vps';
import { Monitor } from '../../models/Monitor';
import { AlertDestination, AlertPolicy, AlertCondition, AlertSilence } from '../../models/Alert';
import { SavedView, ViewWidget } from '../../models/View';
import { LogApiKey } from '../../models/Log';
import { McpApiKey } from '../../models/Mcp';
import { logger } from '../../utils/logger';

// ============================================================================
// CONFIG EXPORT
// ============================================================================
// Exports all portable configuration for a user or organization scope.
// Sensitive fields (API keys, encrypted URIs, HMAC secrets) are stripped.
// Cross-references use stable _exportId identifiers for portability.
// ============================================================================

export const EXPORT_VERSION = '1.0';

interface ExportIdMap {
  [mongoId: string]: string;
}

/**
 * GET /api/data/export/config
 *
 * Downloads the full configuration for the current workspace as a JSON file.
 * Requires owner/admin role for organization context.
 */
export const exportConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    if (!ownerId) {
      return res.status(401).json({ error: 'Unauthorized: Missing workspace context.' });
    }

    // --- Permission check for org context ---
    const orgContext = (req as any).orgContext;
    if (orgContext && !['owner', 'admin'].includes(orgContext.role)) {
      return res.status(403).json({
        error: 'Permission denied.',
        details: 'Only organization owners and admins can export configuration.',
      });
    }

    // --- Fetch all config entities in parallel ---
    const [
      apmServices,
      rumServices,
      taskServices,
      databaseServices,
      websites,
      servers,
      monitors,
      alertDestinations,
      alertPolicies,
      alertConditions,
      alertSilences,
      views,
      viewWidgets,
      logApiKey,
      mcpKeys,
    ] = await Promise.all([
      ApmService.find({ ownerId }).lean(),
      RumService.find({ ownerId }).lean(),
      TaskService.find({ ownerId }).lean(),
      DatabaseService.find({ ownerId }).lean(),
      Website.find({ ownerId }).lean(),
      Vps.find({ ownerId }).lean(),
      Monitor.find({ ownerId }).lean(),
      AlertDestination.find({ ownerId }).lean(),
      AlertPolicy.find({ ownerId }).lean(),
      AlertCondition.find({ ownerId }).lean(),
      AlertSilence.find({ ownerId }).lean(),
      SavedView.find({ ownerId }).lean(),
      ViewWidget.find({ ownerId }).lean(),
      LogApiKey.findOne({ ownerId }).lean(),
      McpApiKey.find({ ownerId, status: 'active' }).lean(),
    ]);

    // --- Build export ID mappings (mongoId -> portable _exportId) ---
    const idMap: ExportIdMap = {};

    const mapIds = (items: any[], prefix: string) => {
      items.forEach((item, i) => {
        idMap[item._id.toString()] = `${prefix}_${i}`;
      });
    };

    mapIds(apmServices, 'apm');
    mapIds(rumServices, 'rum');
    mapIds(taskServices, 'task');
    mapIds(databaseServices, 'db');
    mapIds(websites, 'web');
    mapIds(servers, 'vps');
    mapIds(monitors, 'mon');
    mapIds(alertDestinations, 'dest');
    mapIds(alertPolicies, 'pol');
    mapIds(alertConditions, 'cond');
    mapIds(alertSilences, 'sil');
    mapIds(views, 'view');
    mapIds(viewWidgets, 'wgt');
    mapIds(mcpKeys, 'mcp');

    // --- Helper to remap an ObjectId to its _exportId ---
    const remap = (id: any): string | null => {
      if (!id) return null;
      return idMap[id.toString()] || null;
    };

    // --- Transform entities (strip sensitive, add _exportId, remap refs) ---
    const exportData = {
      apmServices: apmServices.map(s => ({
        _exportId: remap(s._id),
        name: s.name,
        framework: s.framework,
      })),

      rumServices: rumServices.map(s => ({
        _exportId: remap(s._id),
        name: s.name,
        domains: s.domains,
        samplingRate: s.samplingRate,
      })),

      taskServices: taskServices.map(s => ({
        _exportId: remap(s._id),
        name: s.name,
      })),

      databaseServices: databaseServices.map(s => ({
        _exportId: remap(s._id),
        name: s.name,
        type: s.type,
        interval: s.interval,
        // encryptedUri is intentionally stripped for security
      })),

      websites: websites.map(s => ({
        _exportId: remap(s._id),
        name: s.name,
        domain: s.domain,
      })),

      servers: servers.map(s => ({
        _exportId: remap(s._id),
        name: s.name,
        metadata: s.metadata ? { os: s.metadata.os, hostname: s.metadata.hostname } : undefined,
        activeIntegrations: s.activeIntegrations,
      })),

      monitors: monitors.map(m => {
        // Strip Authorization and cookie headers from export (may contain tokens)
        const sanitizedHeaders: Record<string, string> = {};
        if (m.headers && typeof m.headers === 'object') {
          for (const [key, value] of Object.entries(m.headers)) {
            if (/^(authorization|cookie|x-api-key|x-auth-token)$/i.test(key)) continue;
            sanitizedHeaders[key] = value as string;
          }
        }
        return {
          _exportId: remap(m._id),
          name: m.name,
          url: m.url,
          interval: m.interval,
          method: m.method,
          headers: sanitizedHeaders,
          body: m.body,
          expectedStatus: m.expectedStatus,
        };
      }),

      alertDestinations: alertDestinations.map(d => {
        const sanitizedConfig = { ...d.config };
        // Strip HMAC signing secrets
        if (sanitizedConfig.secret) {
          delete sanitizedConfig.secret;
        }
        return {
          _exportId: remap(d._id),
          name: d.name,
          type: d.type,
          config: sanitizedConfig,
        };
      }),

      alertPolicies: alertPolicies.map(p => ({
        _exportId: remap(p._id),
        name: p.name,
        description: p.description || '',
        destinations: (p.destinations || []).map((dId: any) => remap(dId)).filter(Boolean),
      })),

      alertConditions: alertConditions.map(c => ({
        _exportId: remap(c._id),
        policyId: remap(c.policyId),
        name: c.name,
        description: c.description || '',
        target: c.target,
        query: c.query,
        threshold: c.threshold,
        severity: c.severity,
        frequency: c.frequency,
        labels: c.labels,
        isActive: c.isActive,
      })),

      alertSilences: alertSilences.map(s => ({
        _exportId: remap(s._id),
        name: s.name,
        reason: s.reason,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        scope: {
          policyIds: (s.scope?.policyIds || []).map((id: any) => remap(id)).filter(Boolean),
          conditionIds: (s.scope?.conditionIds || []).map((id: any) => remap(id)).filter(Boolean),
          targets: s.scope?.targets || [],
          labels: s.scope?.labels || [],
        },
      })),

      views: views.map(v => ({
        _exportId: remap(v._id),
        name: v.name,
        description: v.description || '',
        // Remap widget IDs in layout to portable _exportId format
        layout: (v.layout || []).map((item: any) => ({
          ...item,
          i: remap(item.i) || item.i,
        })),
      })),

      viewWidgets: viewWidgets.map(w => ({
        _exportId: remap(w._id),
        viewId: remap(w.viewId),
        name: w.name,
        target: w.target,
        query: w.query,
        visualization: w.visualization,
        config: w.config,
      })),

      mcpKeys: mcpKeys.map(k => ({
        _exportId: remap(k._id),
        name: k.name,
        // key is intentionally stripped
      })),

      hasLogApiKey: !!logApiKey,
    };

    // --- Compute integrity checksum ---
    const dataString = JSON.stringify(exportData);
    const checksum = crypto.createHash('sha256').update(dataString).digest('hex');

    const exportPayload = {
      version: EXPORT_VERSION,
      platform: 'senzops',
      exportedAt: new Date().toISOString(),
      scope: orgContext ? 'organization' : 'user',
      checksum: `sha256:${checksum}`,
      data: exportData,
    };

    // --- Entity count summary for logging ---
    const entityCounts = {
      apmServices: apmServices.length,
      rumServices: rumServices.length,
      taskServices: taskServices.length,
      databaseServices: databaseServices.length,
      websites: websites.length,
      servers: servers.length,
      monitors: monitors.length,
      alertDestinations: alertDestinations.length,
      alertPolicies: alertPolicies.length,
      alertConditions: alertConditions.length,
      alertSilences: alertSilences.length,
      views: views.length,
      viewWidgets: viewWidgets.length,
      mcpKeys: mcpKeys.length,
    };

    logger.info(`[DataExport] Config exported for ${ownerId}`, entityCounts);

    // --- Send as downloadable JSON file ---
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `senzops-config-${timestamp}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(exportPayload);
  } catch (error) {
    next(error);
  }
};
