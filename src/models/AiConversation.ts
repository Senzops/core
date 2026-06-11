import mongoose, { Schema, Document } from 'mongoose';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IAiMessage {
  role: 'user' | 'assistant';
  content: string;
  provider?: string;
  model?: string;
  trace?: Record<string, any>;
  createdAt: Date;
}

export interface IAiConversation extends Document {
  ownerId: string;
  title: string;
  provider: string;
  modelId: string;
  messages: IAiMessage[];
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Sub-schema: message
// ---------------------------------------------------------------------------

const AiMessageSchema = new Schema<IAiMessage>(
  {
    role: { type: String, required: true, enum: ['user', 'assistant'] },
    content: { type: String, required: true },
    provider: { type: String },
    model: { type: String },
    trace: { type: Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

// ---------------------------------------------------------------------------
// Main schema: conversation
// ---------------------------------------------------------------------------

const AiConversationSchema = new Schema<IAiConversation>(
  {
    ownerId: { type: String, required: true, index: true },
    title: { type: String, required: true, default: 'New Conversation' },
    provider: { type: String, default: 'webllm' },
    modelId: { type: String, default: '' },
    messages: { type: [AiMessageSchema], default: [] },
    messageCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

AiConversationSchema.index({ ownerId: 1, updatedAt: -1 });

export const AiConversation = mongoose.model<IAiConversation>(
  'AiConversation',
  AiConversationSchema,
);
