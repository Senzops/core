import { Request, Response, NextFunction } from 'express';
import { SavedView, ViewWidget } from '../../models/View';
import { DashboardShare } from '../../models/DashboardShare';

// ============================================================================
// 1. SAVED VIEWS (CANVAS)
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

    // CASCADE: Delete all widgets mapped to this view + any public share links
    await Promise.all([
      ViewWidget.deleteMany({ viewId: id }),
      DashboardShare.deleteMany({ scopeType: 'savedview', scopeId: id, ownerId }),
    ]);

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