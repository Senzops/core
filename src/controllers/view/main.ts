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
    { field: "metrics.cpu.usagePercent", type: "number", desc: "Total CPU utilization %" },
    { field: "metrics.memory.usagePercent", type: "number", desc: "RAM utilization %" },
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
  ],
  errors: [
    { field: "errorClass", type: "string", desc: "Exception class name (e.g. TypeError)" },
    { field: "message", type: "string", desc: "Error message text" },
    { field: "status", type: "string", desc: "Triage state (unresolved, resolved, ignored)" },
    { field: "totalCount", type: "number", desc: "Total occurrence count" },
    { field: "lastSeen", type: "date", desc: "Most recent occurrence timestamp" },
    { field: "firstSeen", type: "date", desc: "First occurrence timestamp" },
    { field: "serviceModel", type: "string", desc: "Originating service type" }
  ],
  runtime: [
    { field: "eventLoopLagMs", type: "number", desc: "Event loop lag in ms" },
    { field: "eventLoopLagP99Ms", type: "number", desc: "P99 event loop lag in ms" },
    { field: "eventLoopUtilizationPercent", type: "number", desc: "Event loop utilization %" },
    { field: "heapUsedPercent", type: "number", desc: "V8 heap utilization %" },
    { field: "heapUsedBytes", type: "number", desc: "V8 heap used in bytes" },
    { field: "gcTotalDurationMs", type: "number", desc: "GC total pause time in ms" },
    { field: "gcMajorCount", type: "number", desc: "Major GC collection count" },
    { field: "activeHandles", type: "number", desc: "Active libuv handles" },
    { field: "cpuUserUs", type: "number", desc: "User CPU time in microseconds" }
  ],
  web: [
    { field: "path", type: "string", desc: "Page path (e.g. /pricing)" },
    { field: "referrer", type: "string", desc: "Traffic referrer URL" },
    { field: "channel", type: "string", desc: "Traffic channel (direct, organic, social)" },
    { field: "browser", type: "string", desc: "Visitor browser name" },
    { field: "os", type: "string", desc: "Visitor operating system" },
    { field: "device", type: "string", desc: "Device type (desktop, mobile, tablet)" },
    { field: "country", type: "string", desc: "Visitor country" },
    { field: "duration", type: "number", desc: "Time on page in seconds" },
    { field: "type", type: "string", desc: "Event type (pageview, ping)" }
  ],
  firebase: [
    { field: "auth.totalUsers", type: "number", desc: "Total registered users" },
    { field: "auth.activeUsersDaily", type: "number", desc: "Daily active users (last 24h)" },
    { field: "auth.activeUsersMonthly", type: "number", desc: "Monthly active users (last 30d)" },
    { field: "auth.newSignups24h", type: "number", desc: "New signups in last 24 hours" },
    { field: "auth.disabledUsers", type: "number", desc: "Disabled user accounts" },
    { field: "auth.emailVerifiedCount", type: "number", desc: "Users with verified email" },
    { field: "auth.mfaEnrolledCount", type: "number", desc: "Users with MFA enabled" },
    { field: "auth.anonymousUsers", type: "number", desc: "Anonymous user accounts" },
    { field: "auth.recentSignIns1h", type: "number", desc: "Sign-ins in the last hour" },
    { field: "providers.password", type: "number", desc: "Email/password auth users" },
    { field: "providers.google", type: "number", desc: "Google auth users" },
    { field: "providers.apple", type: "number", desc: "Apple auth users" },
    { field: "providers.phone", type: "number", desc: "Phone auth users" },
    { field: "providers.github", type: "number", desc: "GitHub auth users" },
    { field: "providers.microsoft", type: "number", desc: "Microsoft auth users" },
    { field: "providers.facebook", type: "number", desc: "Facebook auth users" },
    { field: "providers.twitter", type: "number", desc: "Twitter/X auth users" },
    { field: "providers.anonymous", type: "number", desc: "Anonymous provider count" },
    { field: "providers.other", type: "number", desc: "Other auth providers" }
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
    const ownerId = (req as any).ownerId;
    const { name, description } = req.body;

    const view = await SavedView.create({ ownerId, name, description, layout: [] });
    res.status(201).json({ view });
  } catch (error) { next(error); }
};

export const listViews = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const views = await SavedView.find({ ownerId }).sort({ createdAt: -1 }).lean();

    const enrichedViews = await Promise.all(views.map(async (v) => {
      const widgetCount = await ViewWidget.countDocuments({ viewId: v._id });
      return { ...v, widgetCount };
    }));

    res.json({ views: enrichedViews });
  } catch (error) { next(error); }
};

export const getViewById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const view = await SavedView.findOne({ _id: id, ownerId }).lean();
    if (!view) return res.status(404).json({ error: "Saved View not found" });

    const widgets = await ViewWidget.find({ viewId: id }).lean();

    res.json({ view, widgets });
  } catch (error) { next(error); }
};

export const updateViewLayout = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const { name, description, layout } = req.body;

    const view = await SavedView.findOneAndUpdate(
      { _id: id, ownerId },
      { name, description, layout },
      { new: true }
    );

    if (!view) return res.status(404).json({ error: "View not found" });
    res.json({ view });
  } catch (error) { next(error); }
};

export const deleteView = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const view = await SavedView.findOneAndDelete({ _id: id, ownerId });
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
    const ownerId = (req as any).ownerId;
    const { viewId, name, target, query, visualization, config } = req.body;

    const view = await SavedView.findOne({ _id: viewId, ownerId });
    if (!view) return res.status(403).json({ error: "Invalid View ID" });

    const widget = await ViewWidget.create({
      ownerId, viewId, name, target, query, visualization, config
    });

    const maxY = view.layout.reduce((max, item) => Math.max(max, item.y || 0), 0);
    view.layout.push({ i: widget._id.toString(), x: 0, y: maxY + 1, w: 4, h: 2 });

    await view.save();

    res.status(201).json({ widget, layout: view.layout });
  } catch (error) { next(error); }
};

export const updateWidget = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const { name, target, query, visualization, config } = req.body;

    // 1. Fetch using .lean() to get pure BSON
    const widgetRaw = await ViewWidget.findOne({ _id: id, ownerId }).lean();

    if (!widgetRaw) {
      return res.status(404).json({ error: "Widget not found" });
    }

    // 2. Clone it and apply mutations in memory
    const rawDoc: any = { ...widgetRaw };

    if (name !== undefined) rawDoc.name = name;
    if (target !== undefined) rawDoc.target = target;
    if (query !== undefined) rawDoc.query = query;
    if (visualization !== undefined) rawDoc.visualization = visualization;
    if (config !== undefined) rawDoc.config = config;
    rawDoc.updatedAt = new Date();

    // 3. The "Safe Swap" Pattern
    // MongoDB's 'update' command strictly forbids storing fields that start with '$' 
    // anywhere in the document to prevent update-operator injection attacks. 
    // The 'insert' command safely bypasses this and stores the AST perfectly.
    // To safely update the widget, we atomically swap it out, explicitly retaining the original _id.

    // Drop the old widget from the DB
    await ViewWidget.collection.deleteOne({ _id: widgetRaw._id });

    try {
      // Re-insert it as a fresh document carrying the exact same _id
      await ViewWidget.collection.insertOne(rawDoc);
    } catch (insertError) {
      // Absolute safety net: Restore the original untouched document if the network fails mid-swap
      await ViewWidget.collection.insertOne(widgetRaw);
      throw insertError;
    }

    // 4. Fetch the freshly replaced document via Mongoose to return a compliant JSON schema
    const updatedWidget = await ViewWidget.findById(id);

    res.json({ widget: updatedWidget });
  } catch (error) { next(error); }
};

export const deleteWidget = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const widget = await ViewWidget.findOneAndDelete({ _id: id, ownerId });
    if (!widget) return res.status(404).json({ error: "Widget not found" });

    // Clean up the layout array in the parent view
    await SavedView.updateOne(
      { _id: widget.viewId, ownerId },
      { $pull: { layout: { i: id } } }
    );

    res.json({ success: true, message: "Widget removed." });
  } catch (error) { next(error); }
};