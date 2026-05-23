import mongoose, { Schema, Document } from 'mongoose';

export interface IWebhookEvent extends Document {
  webhookId: string;
  provider: 'dodo' | 'paddle';
  eventType: string;
  status: 'processed' | 'failed' | 'skipped';
  ownerId?: string;
  payload: Record<string, any>;
  error?: string;
  processedAt: Date;
  createdAt: Date;
}

const WebhookEventSchema = new Schema<IWebhookEvent>(
  {
    webhookId: { type: String, required: true, unique: true },
    provider: { type: String, enum: ['dodo', 'paddle'], required: true },
    eventType: { type: String, required: true },
    status: { type: String, enum: ['processed', 'failed', 'skipped'], required: true },
    ownerId: { type: String, index: true },
    payload: { type: Schema.Types.Mixed, required: true },
    error: { type: String },
    processedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

WebhookEventSchema.index({ provider: 1, eventType: 1 });
WebhookEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const WebhookEvent = mongoose.model<IWebhookEvent>('WebhookEvent', WebhookEventSchema);
