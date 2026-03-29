import mongoose, { Schema, Document } from 'mongoose';

// --- 1. Alert Destination (Channels) ---
export interface IAlertDestination extends Document {
  ownerId: string;
  name: string;
  type: 'email' | 'slack' | 'discord';
  config: {
    emails?: string[];
    webhookUrl?: string;
  };
  createdAt: Date;
}

const AlertDestinationSchema = new Schema<IAlertDestination>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  type: { type: String, enum: ['email', 'slack', 'discord'], required: true },
  config: { type: Schema.Types.Mixed, required: true } // Polymorphic config
}, { timestamps: true });


// --- 2. Alert Policy (Grouping) ---
export interface IAlertPolicy extends Document {
  ownerId: string;
  name: string;
  description?: string;
  destinations: mongoose.Types.ObjectId[]; // Linked channels
  createdAt: Date;
}

const AlertPolicySchema = new Schema<IAlertPolicy>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  description: { type: String },
  destinations: [{ type: Schema.Types.ObjectId, ref: 'AlertDestination' }]
}, { timestamps: true });


// --- 3. Alert Condition (The Rule) ---
export interface IAlertCondition extends Document {
  ownerId: string;
  policyId: mongoose.Types.ObjectId;
  name: string;
  target: 'apm' | 'rum' | 'logs' | 'task' | 'vps' | 'database' | 'uptime';
  query: any; // The Safe MQL JSON query
  threshold: {
    operator: 'gt' | 'lt' | 'eq';
    value: number;
    windowMins: number; // e.g., "Look back 5 mins"
  };
  frequency: 'once' | 'always'; // "once per signal" vs "every time it breaches"
  isActive: boolean;
}

const AlertConditionSchema = new Schema<IAlertCondition>({
  ownerId: { type: String, required: true, index: true },
  policyId: { type: Schema.Types.ObjectId, ref: 'AlertPolicy', required: true, index: true },
  name: { type: String, required: true },
  target: { type: String, required: true },
  query: { type: Schema.Types.Mixed, required: true, default: {} },
  threshold: {
    operator: { type: String, enum: ['gt', 'lt', 'eq'], required: true },
    value: { type: Number, required: true },
    windowMins: { type: Number, required: true, default: 5 }
  },
  frequency: { type: String, enum: ['once', 'always'], default: 'once' },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });


// --- 4. Alert Incident (The Event State) ---
export interface IAlertIncident extends Document {
  ownerId: string;
  policyId: mongoose.Types.ObjectId;
  conditionId: mongoose.Types.ObjectId;
  status: 'open' | 'acknowledged' | 'resolved';
  triggerValue: number;
  openedAt: Date;
  resolvedAt?: Date;
}

const AlertIncidentSchema = new Schema<IAlertIncident>({
  ownerId: { type: String, required: true, index: true },
  policyId: { type: Schema.Types.ObjectId, ref: 'AlertPolicy', required: true },
  conditionId: { type: Schema.Types.ObjectId, ref: 'AlertCondition', required: true },
  status: { type: String, enum: ['open', 'acknowledged', 'resolved'], default: 'open', index: true },
  triggerValue: { type: Number, required: true },
  openedAt: { type: Date, default: Date.now },
  resolvedAt: { type: Date }
});

export const AlertDestination = mongoose.model<IAlertDestination>('AlertDestination', AlertDestinationSchema);
export const AlertPolicy = mongoose.model<IAlertPolicy>('AlertPolicy', AlertPolicySchema);
export const AlertCondition = mongoose.model<IAlertCondition>('AlertCondition', AlertConditionSchema);
export const AlertIncident = mongoose.model<IAlertIncident>('AlertIncident', AlertIncidentSchema);