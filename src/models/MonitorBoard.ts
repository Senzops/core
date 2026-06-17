import mongoose, { Schema, Document } from 'mongoose';

/**
 * MonitorBoard — a centralized, customizable "Status Board" that composes a set
 * of uptime monitors into a single shareable dashboard.
 *
 * The board itself stores only layout (which monitors are on it and where), in
 * the same react-grid-layout format used by SavedView (`{ i, x, y, w, h }`),
 * where `i` is the monitor's `_id`. The live data (status, uptime, latency, the
 * check stripe) is resolved on read from MonitorRun/MonitorIncident — the board
 * never duplicates telemetry.
 *
 * A workspace can own many boards (e.g. an internal board and a customer-facing
 * public status page), each shared independently via DashboardShare.
 */
export interface IMonitorBoardItem {
  i: string; // Monitor _id this card maps to
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface IMonitorBoard extends Document {
  ownerId: string;
  name: string;
  description?: string;
  layout: IMonitorBoardItem[];
  createdAt: Date;
  updatedAt: Date;
}

const MonitorBoardSchema = new Schema<IMonitorBoard>(
  {
    ownerId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 500 },
    layout: [
      {
        i: { type: String, required: true },
        x: { type: Number, required: true },
        y: { type: Number, required: true },
        w: { type: Number, required: true },
        h: { type: Number, required: true },
        _id: false,
      },
    ],
  },
  { timestamps: true }
);

export const MonitorBoard = mongoose.model<IMonitorBoard>('MonitorBoard', MonitorBoardSchema);
