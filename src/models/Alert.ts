import mongoose, { Schema, Document } from 'mongoose';

// ============================================================================
// 1. ALERT DESTINATION (Notification Channels)
// ============================================================================
export interface IAlertDestination extends Document {
  ownerId: string;
  name: string;
  type: 'email' | 'slack' | 'discord' | 'webhook';
  config: {
    emails?: string[];
    webhookUrl?: string;
    // Webhook-specific
    method?: 'POST' | 'PUT';
    headers?: Record<string, string>;
    secret?: string; // HMAC signing secret
  };
  createdAt: Date;
  updatedAt: Date;
}

const AlertDestinationSchema = new Schema<IAlertDestination>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  type: { type: String, enum: ['email', 'slack', 'discord', 'webhook'], required: true },
  config: { type: Schema.Types.Mixed, required: true }
}, { timestamps: true });


// ============================================================================
// 2. ALERT POLICY (Grouping & Routing)
// ============================================================================
export interface IAlertPolicy extends Document {
  ownerId: string;
  name: string;
  description?: string;
  destinations: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const AlertPolicySchema = new Schema<IAlertPolicy>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  description: { type: String },
  destinations: [{ type: Schema.Types.ObjectId, ref: 'AlertDestination' }]
}, { timestamps: true });


// ============================================================================
// 3. ALERT CONDITION (Evaluation Rule)
// ============================================================================
export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface IAlertCondition extends Document {
  ownerId: string;
  policyId: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  target: 'apm' | 'rum' | 'logs' | 'task' | 'vps' | 'database' | 'uptime';
  query: any;
  threshold: {
    operator: 'gt' | 'lt' | 'eq' | 'gte' | 'lte' | 'neq';
    value: number;
    windowMins: number;
  };
  severity: AlertSeverity;
  frequency: 'once' | 'always';
  labels: string[];
  muteUntil: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const AlertConditionSchema = new Schema<IAlertCondition>({
  ownerId: { type: String, required: true, index: true },
  policyId: { type: Schema.Types.ObjectId, ref: 'AlertPolicy', required: true, index: true },
  name: { type: String, required: true },
  description: { type: String, default: '' },
  target: { type: String, required: true },
  query: { type: Schema.Types.Mixed, required: true, default: {} },
  threshold: {
    operator: { type: String, enum: ['gt', 'lt', 'eq', 'gte', 'lte', 'neq'], required: true },
    value: { type: Number, required: true },
    windowMins: { type: Number, required: true, default: 5 }
  },
  severity: { type: String, enum: ['critical', 'high', 'medium', 'low', 'info'], default: 'high' },
  frequency: { type: String, enum: ['once', 'always'], default: 'once' },
  labels: { type: [String], default: [] },
  muteUntil: { type: Date, default: null },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });


// ============================================================================
// 4. ALERT INCIDENT (Event Lifecycle)
// ============================================================================
export interface ITimelineEvent {
  type: 'fired' | 'acknowledged' | 'resolved' | 'reopened' | 'severity_changed' | 'assigned' | 'note' | 'notification_sent' | 'notification_failed' | 'escalated';
  message: string;
  userId?: string;
  metadata?: Record<string, any>;
  timestamp: Date;
}

export interface IAlertIncident extends Document {
  ownerId: string;
  policyId: mongoose.Types.ObjectId;
  conditionId: mongoose.Types.ObjectId;
  incidentNumber: number;
  title: string;
  severity: AlertSeverity;
  status: 'open' | 'acknowledged' | 'resolved';
  triggerValue: number;
  labels: string[];
  assigneeId?: string;
  timeline: ITimelineEvent[];
  lastNotifiedAt?: Date;
  openedAt: Date;
  acknowledgedAt?: Date;
  resolvedAt?: Date;
}

const TimelineEventSchema = new Schema<ITimelineEvent>({
  type: { type: String, required: true, enum: ['fired', 'acknowledged', 'resolved', 'reopened', 'severity_changed', 'assigned', 'note', 'notification_sent', 'notification_failed', 'escalated'] },
  message: { type: String, required: true },
  userId: { type: String },
  metadata: { type: Schema.Types.Mixed },
  timestamp: { type: Date, default: Date.now }
}, { _id: true });

const AlertIncidentSchema = new Schema<IAlertIncident>({
  ownerId: { type: String, required: true, index: true },
  policyId: { type: Schema.Types.ObjectId, ref: 'AlertPolicy', required: true, index: true },
  conditionId: { type: Schema.Types.ObjectId, ref: 'AlertCondition', required: true, index: true },
  incidentNumber: { type: Number, required: true },
  title: { type: String, required: true },
  severity: { type: String, enum: ['critical', 'high', 'medium', 'low', 'info'], default: 'high', index: true },
  status: { type: String, enum: ['open', 'acknowledged', 'resolved'], default: 'open', index: true },
  triggerValue: { type: Number, required: true },
  labels: { type: [String], default: [] },
  assigneeId: { type: String },
  timeline: { type: [TimelineEventSchema], default: [] },
  lastNotifiedAt: { type: Date },
  openedAt: { type: Date, default: Date.now },
  acknowledgedAt: { type: Date },
  resolvedAt: { type: Date }
});

AlertIncidentSchema.index({ ownerId: 1, status: 1, severity: 1 });
AlertIncidentSchema.index({ ownerId: 1, openedAt: -1 });
AlertIncidentSchema.index({ conditionId: 1, status: 1 });
AlertIncidentSchema.index({ ownerId: 1, incidentNumber: -1 }, { unique: true });


// ============================================================================
// 5. ALERT SILENCE WINDOW (Maintenance / Muting)
// ============================================================================
export interface IAlertSilence extends Document {
  ownerId: string;
  name: string;
  reason: string;
  startsAt: Date;
  endsAt: Date;
  scope: {
    policyIds?: mongoose.Types.ObjectId[];
    conditionIds?: mongoose.Types.ObjectId[];
    targets?: string[];
    labels?: string[];
  };
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const AlertSilenceSchema = new Schema<IAlertSilence>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  reason: { type: String, required: true },
  startsAt: { type: Date, required: true },
  endsAt: { type: Date, required: true },
  scope: {
    policyIds: [{ type: Schema.Types.ObjectId, ref: 'AlertPolicy' }],
    conditionIds: [{ type: Schema.Types.ObjectId, ref: 'AlertCondition' }],
    targets: [{ type: String }],
    labels: [{ type: String }]
  },
  createdBy: { type: String, required: true }
}, { timestamps: true });

AlertSilenceSchema.index({ ownerId: 1, endsAt: 1 });


// ============================================================================
// 6. INCIDENT COUNTER (Auto-increment per owner)
// ============================================================================
export interface IIncidentCounter extends Document {
  ownerId: string;
  seq: number;
}

const IncidentCounterSchema = new Schema<IIncidentCounter>({
  ownerId: { type: String, required: true, unique: true },
  seq: { type: Number, default: 0 }
});

export const getNextIncidentNumber = async (ownerId: string): Promise<number> => {
  const counter = await IncidentCounter.findOneAndUpdate(
    { ownerId },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );
  return counter.seq;
};


// ============================================================================
// EXPORTS
// ============================================================================
export const AlertDestination = mongoose.model<IAlertDestination>('AlertDestination', AlertDestinationSchema);
export const AlertPolicy = mongoose.model<IAlertPolicy>('AlertPolicy', AlertPolicySchema);
export const AlertCondition = mongoose.model<IAlertCondition>('AlertCondition', AlertConditionSchema);
export const AlertIncident = mongoose.model<IAlertIncident>('AlertIncident', AlertIncidentSchema);
export const AlertSilence = mongoose.model<IAlertSilence>('AlertSilence', AlertSilenceSchema);
export const IncidentCounter = mongoose.model<IIncidentCounter>('IncidentCounter', IncidentCounterSchema);
