// ============================================================================
// Retention Registry — the authoritative list of plan-based telemetry stores
// ----------------------------------------------------------------------------
// Every collection whose retention follows the customer's plan is declared
// here exactly once. Both the plan-change reconciler
// (src/services/retentionReconciler.ts) and the TTL migration script
// (src/scripts/migrateRetentionTTL.ts) drive off this single list so the two
// can never disagree about which collections, anchors, or owner scoping apply.
//
// Each entry knows:
//   - `model`        the Mongoose model.
//   - `anchorField`  the document's logical time field. The retention window is
//                    measured from this, and it carries the hard-cap backstop
//                    TTL index.
//   - `ownerFilter`  builds a Mongo filter selecting an owner's documents. For
//                    owner-attributed collections this is `{ ownerId }`; for
//                    service-attributed collections it resolves the owner's
//                    parent ids first and scopes by the foreign key. Returns
//                    `null` when the owner has no matching documents.
//
// Operational (non-telemetry) collections — WebhookEvent, OtpCode,
// OrganizationInvitation, SystemLock, LogIngestStat — are deliberately absent;
// they keep fixed, non-plan-based TTLs.
// ============================================================================

import { Model } from 'mongoose';

import { ApmTrace, ApmMetric, ApmService } from '../models/Apm';
import { RumTrace, RumMetric, RumService } from '../models/Rum';
import { RuntimeMetric } from '../models/RuntimeMetric';
import { TaskRun, TaskMetric, TaskService } from '../models/Task';
import { DbMetric, DatabaseService } from '../models/Database';
import { QueueMetric, QueueRollup, QueueSource } from '../models/Queue';
import { FirebaseMetric, FirebaseService } from '../models/Firebase';
import { LogEvent } from '../models/Log';
import { McpUsage } from '../models/Mcp';
import { MonitorRun, MonitorIncident, Monitor } from '../models/Monitor';
import { ErrorGroup, ErrorEvent } from '../models/Error';
import { WebEvent, WebMetric, Website } from '../models/Web';
import { VpsRun, Vps } from '../models/Vps';

export type OwnerFilter = Record<string, any> | null;

export interface RetentionCollection {
  /** Stable human-readable label for logs. */
  label: string;
  /** The Mongoose model backing the collection. */
  model: Model<any>;
  /** Logical time field the retention window is measured from. */
  anchorField: string;
  /** Builds a filter selecting this owner's documents (or null if none). */
  ownerFilter: (ownerId: string) => Promise<OwnerFilter>;
}

/** Owner-attributed collections carry `ownerId` directly on each document. */
const byOwnerId = (ownerId: string): Promise<OwnerFilter> =>
  Promise.resolve({ ownerId });

/**
 * Service-attributed collections reference a parent registry document. We
 * resolve the owner's parent ids, then scope by the foreign key. Returns null
 * when the owner owns no parents (nothing to reconcile/migrate).
 */
const byParent = (parent: Model<any>, foreignKey: string) =>
  async (ownerId: string): Promise<OwnerFilter> => {
    const ids = await parent.find({ ownerId }).distinct('_id');
    return ids.length ? { [foreignKey]: { $in: ids } } : null;
  };

export const RETENTION_COLLECTIONS: RetentionCollection[] = [
  // --- Owner-attributed ---
  { label: 'LogEvent', model: LogEvent, anchorField: 'timestamp', ownerFilter: byOwnerId },
  { label: 'McpUsage', model: McpUsage, anchorField: 'timestamp', ownerFilter: byOwnerId },
  { label: 'ErrorGroup', model: ErrorGroup, anchorField: 'lastSeen', ownerFilter: byOwnerId },
  { label: 'MonitorIncident', model: MonitorIncident, anchorField: 'createdAt', ownerFilter: byOwnerId },

  // --- Service-attributed (APM) ---
  { label: 'ApmTrace', model: ApmTrace, anchorField: 'createdAt', ownerFilter: byParent(ApmService, 'serviceId') },
  { label: 'ApmMetric', model: ApmMetric, anchorField: 'timestamp', ownerFilter: byParent(ApmService, 'serviceId') },
  { label: 'RuntimeMetric', model: RuntimeMetric, anchorField: 'timestamp', ownerFilter: byParent(ApmService, 'serviceId') },

  // --- Service-attributed (RUM) ---
  { label: 'RumTrace', model: RumTrace, anchorField: 'timestamp', ownerFilter: byParent(RumService, 'serviceId') },
  { label: 'RumMetric', model: RumMetric, anchorField: 'timestamp', ownerFilter: byParent(RumService, 'serviceId') },

  // --- Service-attributed (Task) ---
  { label: 'TaskRun', model: TaskRun, anchorField: 'timestamp', ownerFilter: byParent(TaskService, 'serviceId') },
  { label: 'TaskMetric', model: TaskMetric, anchorField: 'timestamp', ownerFilter: byParent(TaskService, 'serviceId') },

  // --- Service-attributed (Queue monitoring) ---
  { label: 'QueueMetric', model: QueueMetric, anchorField: 'timestamp', ownerFilter: byParent(QueueSource, 'sourceId') },
  { label: 'QueueRollup', model: QueueRollup, anchorField: 'timestamp', ownerFilter: byParent(QueueSource, 'sourceId') },

  // --- Service-attributed (Database / Firebase) ---
  { label: 'DbMetric', model: DbMetric, anchorField: 'timestamp', ownerFilter: byParent(DatabaseService, 'dbId') },
  { label: 'FirebaseMetric', model: FirebaseMetric, anchorField: 'timestamp', ownerFilter: byParent(FirebaseService, 'serviceId') },

  // --- Service-attributed (Web analytics) ---
  { label: 'WebEvent', model: WebEvent, anchorField: 'createdAt', ownerFilter: byParent(Website, 'webId') },
  { label: 'WebMetric', model: WebMetric, anchorField: 'timestamp', ownerFilter: byParent(Website, 'webId') },

  // --- Service-attributed (VPS / Monitors) ---
  { label: 'VpsRun', model: VpsRun, anchorField: 'createdAt', ownerFilter: byParent(Vps, 'vpsId') },
  { label: 'MonitorRun', model: MonitorRun, anchorField: 'createdAt', ownerFilter: byParent(Monitor, 'monitorId') },

  // --- Error events: scoped through the owner's error groups (no ownerId of their own) ---
  {
    label: 'ErrorEvent',
    model: ErrorEvent,
    anchorField: 'timestamp',
    ownerFilter: async (ownerId: string): Promise<OwnerFilter> => {
      const groupIds = await ErrorGroup.find({ ownerId }).distinct('_id');
      return groupIds.length ? { groupId: { $in: groupIds } } : null;
    },
  },
];
