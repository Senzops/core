import mongoose, { Schema, Document } from 'mongoose';

// --- 1. Saved View (The Canvas & Layout) ---
export interface ISavedView extends Document {
  ownerId: string;
  name: string;
  description?: string;
  // react-grid-layout standardized format
  layout: Array<{
    i: string; // Widget ID mapping
    x: number;
    y: number;
    w: number;
    h: number;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

const SavedViewSchema = new Schema<ISavedView>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  description: { type: String },
  layout: [{
    i: { type: String, required: true },
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    w: { type: Number, required: true },
    h: { type: Number, required: true }
  }]
}, { timestamps: true });


// --- 2. View Widget (The Data & Visual Config) ---
export interface IViewWidget extends Document {
  ownerId: string;
  viewId: mongoose.Types.ObjectId;
  name: string;
  target: 'apm' | 'rum' | 'logs' | 'task' | 'vps' | 'database' | 'uptime';
  query: any; // The Safe MQL filter
  visualization: 'area' | 'line' | 'bar' | 'pie' | 'billboard' | 'table' | 'gauge' | 'radar' | 'map' | 'json';
  config: {
    aggregate: 'count' | 'avg' | 'sum' | 'max' | 'min'; // Math function
    aggregateField?: string; // Field to do math on (e.g. 'duration')
    groupBy?: string; // Categorical split (e.g. 'status', 'method')
  };
}

const ViewWidgetSchema = new Schema<IViewWidget>({
  ownerId: { type: String, required: true, index: true },
  viewId: { type: Schema.Types.ObjectId, ref: 'SavedView', required: true, index: true },
  name: { type: String, required: true },
  target: { type: String, required: true },
  query: { type: Schema.Types.Mixed, required: true, default: {} },
  visualization: { 
    type: String,
    enum: ['area', 'line', 'bar', 'pie', 'billboard', 'table', 'gauge', 'radar', 'map', 'json'], 
    required: true 
  },
  config: {
    aggregate: { type: String, enum: ['count', 'avg', 'sum', 'max', 'min'], required: true, default: 'count' },
    aggregateField: { type: String },
    groupBy: { type: String }
  }
}, { timestamps: true });

export const SavedView = mongoose.model<ISavedView>('SavedView', SavedViewSchema);
export const ViewWidget = mongoose.model<IViewWidget>('ViewWidget', ViewWidgetSchema);