import { Request, Response, NextFunction } from 'express';
import { SavedView, ViewWidget } from '../../models/View';

// ============================================================================
// 1. DYNAMIC SCHEMA DICTIONARY
// ============================================================================
const SYSTEM_SCHEMA_DICTIONARY = {
  apm: [
    { field: "duration", type: "number", desc: "Execution latency in ms" },
    { field: "status", type: "number", desc: "HTTP Response code (e.g. 500)" },
    { field: "route", type: "string", desc: "Endpoint route (e.g. /api/users)" },
    { field: "method", type: "string", desc: "HTTP Method (GET, POST)" }
  ],
  logs: [
    { field: "level", type: "string", desc: "Log severity (error, warn, info)" },
    { field: "message", type: "string", desc: "Full log text body (supports regex)" },
    { field: "serviceModel", type: "string", desc: "Originating service type" }
  ],
  vps: [
    { field: "metrics.cpu.usage", type: "number", desc: "Total CPU utilization %" },
    { field: "metrics.memory.usedPercent", type: "number", desc: "RAM utilization %" },
    { field: "isOnline", type: "boolean", desc: "Agent heartbeat status" }
  ],
  database: [
    { field: "latency", type: "number", desc: "Query response time in ms" },
    { field: "connections", type: "number", desc: "Active DB connections" },
    { field: "ops", type: "number", desc: "Operations per second" }
  ],
  uptime: [
    { field: "status", type: "string", desc: "Endpoint health ('up' or 'down')" },
    { field: "latency", type: "number", desc: "Ping latency in ms" }
  ],
  rum: [
    { field: "metrics.lcp", type: "number", desc: "Largest Contentful Paint ms" },
    { field: "metrics.cls", type: "number", desc: "Cumulative Layout Shift" },
    { field: "browser", type: "string", desc: "User Agent browser string" }
  ],
  task: [
    { field: "status", type: "string", desc: "Job execution ('completed', 'failed')" },
    { field: "duration", type: "number", desc: "Job runtime in ms" },
    { field: "taskName", type: "string", desc: "Specific worker/queue name" }
  ]
};

export const getSchemaDictionary = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ schema: SYSTEM_SCHEMA_DICTIONARY });
  } catch (error) { next(error); }
};

// ============================================================================
// 2. SAVED VIEWS (CANVAS)
// ============================================================================
export const createView = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { name, description } = req.body;

    const view = await SavedView.create({ ownerId: uid, name, description, layout: [] });
    res.status(201).json({ view });
  } catch (error) { next(error); }
};

export const listViews = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const views = await SavedView.find({ ownerId: uid }).sort({ createdAt: -1 }).lean();

    const enrichedViews = await Promise.all(views.map(async (v) => {
      const widgetCount = await ViewWidget.countDocuments({ viewId: v._id });
      return { ...v, widgetCount };
    }));

    res.json({ views: enrichedViews });
  } catch (error) { next(error); }
};

export const getViewById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;

    const view = await SavedView.findOne({ _id: id, ownerId: uid }).lean();
    if (!view) return res.status(404).json({ error: "Saved View not found" });

    const widgets = await ViewWidget.find({ viewId: id }).lean();

    res.json({ view, widgets });
  } catch (error) { next(error); }
};

export const updateViewLayout = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;
    const { name, description, layout } = req.body;

    const view = await SavedView.findOneAndUpdate(
      { _id: id, ownerId: uid },
      { name, description, layout },
      { new: true }
    );

    if (!view) return res.status(404).json({ error: "View not found" });
    res.json({ view });
  } catch (error) { next(error); }
};

export const deleteView = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;

    const view = await SavedView.findOneAndDelete({ _id: id, ownerId: uid });
    if (!view) return res.status(404).json({ error: "View not found" });

    // CASCADE: Delete all widgets mapped to this view
    await ViewWidget.deleteMany({ viewId: id });

    res.json({ success: true, message: "View and all associated widgets deleted." });
  } catch (error) { next(error); }
};

// ============================================================================
// 3. WIDGETS
// ============================================================================
export const createWidget = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { viewId, name, target, query, visualization, config } = req.body;

    const view = await SavedView.findOne({ _id: viewId, ownerId: uid });
    if (!view) return res.status(403).json({ error: "Invalid View ID" });

    const widget = await ViewWidget.create({
      ownerId: uid, viewId, name, target, query, visualization, config
    });

    // THE FIX: Do not use Infinity (JSON.stringify converts it to null, crashing Mongoose)
    // Safely calculate the bottom of the grid layout using maxY + 1
    const maxY = view.layout.reduce((max, item) => Math.max(max, item.y || 0), 0);
    view.layout.push({ i: widget._id.toString(), x: 0, y: maxY + 1, w: 4, h: 2 });

    await view.save();

    res.status(201).json({ widget, layout: view.layout });
  } catch (error) { next(error); }
};

export const updateWidget = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;
    const { name, target, query, visualization, config } = req.body;

    const widget = await ViewWidget.findOneAndUpdate(
      { _id: id, ownerId: uid },
      { name, target, query, visualization, config },
      { new: true }
    );

    if (!widget) return res.status(404).json({ error: "Widget not found" });
    res.json({ widget });
  } catch (error) { next(error); }
};

export const deleteWidget = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;

    const widget = await ViewWidget.findOneAndDelete({ _id: id, ownerId: uid });
    if (!widget) return res.status(404).json({ error: "Widget not found" });

    // Clean up the layout array in the parent view
    await SavedView.updateOne(
      { _id: widget.viewId, ownerId: uid },
      { $pull: { layout: { i: id } } }
    );

    res.json({ success: true, message: "Widget removed." });
  } catch (error) { next(error); }
};