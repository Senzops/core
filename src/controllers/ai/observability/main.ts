import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { AiSource, AiTrace, AiGeneration, AiMetric, AiScore } from '../../../models/Ai';
import { ErrorGroup, ErrorEvent } from '../../../models/Error';
import { LogEvent } from '../../../models/Log';
import { DashboardShare } from '../../../models/DashboardShare';
import { RegisterAiSchema, UpdateAiSchema } from '../../../utils/validation';

const DEFAULT_SETTINGS = {
  captureContent: false,
  maskingRules: [] as string[],
  pricingOverrides: {} as Record<string, { input: number; output: number }>,
  sampleRate: 1,
};

// --- Register a new AI source ---
export const registerAiSource = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { name, type, settings, managementUrl } = RegisterAiSchema.parse(req.body);

    const apiKey = `sz_ai_${crypto.randomBytes(24).toString('hex')}`;

    const source = await AiSource.create({
      ownerId,
      name,
      apiKey,
      type,
      settings: { ...DEFAULT_SETTINGS, ...(settings || {}) },
      managementUrl: managementUrl || undefined,
    });

    res.status(201).json({
      message: 'AI source created',
      sourceId: source._id,
      apiKey, // Shown once
    });
  } catch (error) {
    next(error);
  }
};

// --- List AI sources ---
export const listAiSources = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const sources = await AiSource.find({ ownerId }).sort({ createdAt: -1 }).lean();
    res.json(sources);
  } catch (error) {
    next(error);
  }
};

// --- Get a single AI source (config + meta) ---
export const getAiSource = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const source = await AiSource.findOne({ _id: id, ownerId }).lean();
    if (!source) return res.status(404).json({ error: 'AI source not found' });
    res.json(source);
  } catch (error) {
    next(error);
  }
};

// --- Update an AI source ---
export const updateAiSource = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const updates = UpdateAiSchema.parse(req.body);

    // Flatten settings to dot-paths so a partial settings update doesn't wipe
    // sibling fields.
    const set: Record<string, any> = {};
    if (updates.name !== undefined) set.name = updates.name;
    if (updates.managementUrl !== undefined) set.managementUrl = updates.managementUrl || undefined;
    if (updates.settings) {
      for (const [k, v] of Object.entries(updates.settings)) {
        set[`settings.${k}`] = v;
      }
    }

    const updated = await AiSource.findOneAndUpdate(
      { _id: id, ownerId },
      { $set: set },
      { new: true, runValidators: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: 'AI source not found' });

    res.json({ message: 'AI source updated', source: updated });
  } catch (error) {
    next(error);
  }
};

// --- Delete an AI source and cascade-purge its telemetry ---
export const deleteAiSource = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const result = await AiSource.findOneAndDelete({ _id: id, ownerId });
    if (!result) return res.status(404).json({ error: 'AI source not found' });

    await Promise.all([
      AiTrace.deleteMany({ sourceId: id }),
      AiGeneration.deleteMany({ sourceId: id }),
      AiMetric.deleteMany({ sourceId: id }),
      AiScore.deleteMany({ sourceId: id }),
      ErrorGroup.deleteMany({ serviceId: id, serviceModel: 'AiSource' }),
      ErrorEvent.deleteMany({ serviceId: id, serviceModel: 'AiSource' }),
      LogEvent.deleteMany({ serviceId: id, serviceModel: 'AiSource' }),
      DashboardShare.deleteMany({ scopeType: 'ai', scopeId: id, ownerId }),
    ]);

    res.json({ message: 'AI source and all associated telemetry successfully purged.' });
  } catch (error) {
    next(error);
  }
};
