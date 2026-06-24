import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Website, WebAnnotation } from '../../models/Web';
import { CreateAnnotationSchema, UpdateAnnotationSchema } from '../../utils/validation';
import { resolveTimeRange, getEffectiveRetention, TimeRangeError } from '../../utils/timeRange';

const MAX_ANNOTATIONS_PER_SITE = 500;

const resolveSite = async (req: Request) => {
  const ownerId = (req as any).ownerId;
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id.trim())) return { error: 'Invalid website id' as const };
  const site = await Website.findOne({ _id: id.trim(), ownerId }).select('_id ownerId').lean();
  if (!site) return { error: 'Website not found' as const };
  return { ownerId, webId: id.trim() };
};

// --- List (optionally scoped to the dashboard's time window) ---
export const listAnnotations = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resolved = await resolveSite(req);
    if ('error' in resolved) {
      return res.status(resolved.error === 'Website not found' ? 404 : 400).json({ error: resolved.error });
    }

    const query: any = { ownerId: resolved.ownerId, webId: resolved.webId };

    // If a time window is supplied, constrain annotations to it (mirrors the chart).
    const { range, start, end } = req.query as Record<string, string>;
    if (range || (start && end)) {
      try {
        const maxRetention = await getEffectiveRetention('web', resolved.ownerId);
        const tr = resolveTimeRange({ range, start, end }, maxRetention);
        query.date = { $gte: tr.startDate, $lte: tr.endDate };
      } catch (e) {
        if (e instanceof TimeRangeError) return res.status(400).json({ error: e.message });
        throw e;
      }
    }

    const annotations = await WebAnnotation.find(query).sort({ date: 1 }).limit(MAX_ANNOTATIONS_PER_SITE).lean();
    res.json(annotations);
  } catch (error) {
    next(error);
  }
};

// --- Create ---
export const createAnnotation = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resolved = await resolveSite(req);
    if ('error' in resolved) {
      return res.status(resolved.error === 'Website not found' ? 404 : 400).json({ error: resolved.error });
    }

    const parsed = CreateAnnotationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid annotation', details: parsed.error.flatten().fieldErrors });
    }

    const count = await WebAnnotation.countDocuments({ ownerId: resolved.ownerId, webId: resolved.webId });
    if (count >= MAX_ANNOTATIONS_PER_SITE) {
      return res.status(402).json({ error: `Annotation limit reached (${MAX_ANNOTATIONS_PER_SITE} per website).` });
    }

    const annotation = await WebAnnotation.create({
      ownerId: resolved.ownerId,
      webId: resolved.webId,
      date: new Date(parsed.data.date),
      text: parsed.data.text,
      color: parsed.data.color,
      createdBy: (req as any).user?.uid,
    });

    res.status(201).json({ message: 'Annotation created', annotation });
  } catch (error) {
    next(error);
  }
};

// --- Update ---
export const updateAnnotation = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resolved = await resolveSite(req);
    if ('error' in resolved) {
      return res.status(resolved.error === 'Website not found' ? 404 : 400).json({ error: resolved.error });
    }

    const { annotationId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(annotationId)) return res.status(400).json({ error: 'Invalid annotation id' });

    const parsed = UpdateAnnotationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid annotation', details: parsed.error.flatten().fieldErrors });
    }

    const update: any = { ...parsed.data };
    if (parsed.data.date) update.date = new Date(parsed.data.date);

    const updated = await WebAnnotation.findOneAndUpdate(
      { _id: annotationId, ownerId: resolved.ownerId, webId: resolved.webId },
      update,
      { new: true, runValidators: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: 'Annotation not found' });

    res.json({ message: 'Annotation updated', annotation: updated });
  } catch (error) {
    next(error);
  }
};

// --- Delete ---
export const deleteAnnotation = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resolved = await resolveSite(req);
    if ('error' in resolved) {
      return res.status(resolved.error === 'Website not found' ? 404 : 400).json({ error: resolved.error });
    }

    const { annotationId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(annotationId)) return res.status(400).json({ error: 'Invalid annotation id' });

    const deleted = await WebAnnotation.findOneAndDelete({ _id: annotationId, ownerId: resolved.ownerId, webId: resolved.webId });
    if (!deleted) return res.status(404).json({ error: 'Annotation not found' });

    res.json({ message: 'Annotation deleted' });
  } catch (error) {
    next(error);
  }
};
