import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import zlib from 'zlib';
import { RumService } from '../../models/Rum';
import { SourceMap } from '../../models/SourceMap';
import { symbolicateStack } from '../../services/symbolicate';
import { logger } from '../../utils/logger';

const MAX_MAPS_PER_SERVICE = 500;
const MAX_RAW_BYTES = 30 * 1024 * 1024;   // 30MB uncompressed map JSON
const MAX_GZ_BYTES = 8 * 1024 * 1024;     // 8MB stored gzipped

const basenameOf = (name: string): string => {
  const noQuery = String(name).split('?')[0].split('#')[0];
  const parts = noQuery.split('/');
  return (parts[parts.length - 1] || noQuery).slice(0, 256);
};

// --- Upload (authenticated by the RUM service ingest API key) ---
export const uploadSourceMap = async (req: Request, res: Response) => {
  try {
    const apiKey = (req.headers['x-service-api-key'] || req.query.apiKey || req.body?.apiKey) as string;
    if (!apiKey) return res.status(401).json({ error: 'Missing API Key' });

    const service = await RumService.findOne({ apiKey }).select('_id ownerId');
    if (!service) return res.status(403).json({ error: 'Invalid API Key' });

    const { release, fileName, sourceMap } = req.body || {};
    if (!fileName || !sourceMap) {
      return res.status(400).json({ error: 'fileName and sourceMap are required.' });
    }

    // Accept either a JSON object or a stringified map.
    let mapString: string;
    try {
      mapString = typeof sourceMap === 'string' ? sourceMap : JSON.stringify(sourceMap);
    } catch {
      return res.status(400).json({ error: 'sourceMap must be valid JSON.' });
    }

    const rawBytes = Buffer.byteLength(mapString, 'utf8');
    if (rawBytes > MAX_RAW_BYTES) {
      return res.status(413).json({ error: `Source map too large (${Math.round(rawBytes / 1048576)}MB). Max ${MAX_RAW_BYTES / 1048576}MB — code-split to reduce per-file size.` });
    }

    const mapGz = zlib.gzipSync(Buffer.from(mapString, 'utf8'));
    if (mapGz.length > MAX_GZ_BYTES) {
      return res.status(413).json({ error: 'Compressed source map exceeds the storage limit.' });
    }

    const cleanFile = basenameOf(fileName);
    const cleanRelease = (release ? String(release) : 'default').slice(0, 100);

    await SourceMap.findOneAndUpdate(
      { serviceId: service._id, release: cleanRelease, fileName: cleanFile },
      { $set: { ownerId: service.ownerId, mapGz, size: rawBytes } },
      { upsert: true, new: true }
    );

    // Bound storage: evict the oldest beyond the cap for this service.
    const count = await SourceMap.countDocuments({ serviceId: service._id });
    if (count > MAX_MAPS_PER_SERVICE) {
      const stale = await SourceMap.find({ serviceId: service._id })
        .sort({ createdAt: 1 })
        .limit(count - MAX_MAPS_PER_SERVICE)
        .select('_id')
        .lean();
      await SourceMap.deleteMany({ _id: { $in: stale.map((s) => s._id) } });
    }

    res.status(201).json({ message: 'Source map uploaded', fileName: cleanFile, release: cleanRelease, size: rawBytes });
  } catch (error: any) {
    logger.error('[SourceMap] Upload error', error);
    res.status(500).json({ error: 'Failed to store source map' });
  }
};

const resolveService = async (req: Request) => {
  const ownerId = (req as any).ownerId;
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) return { error: 'Invalid service id' as const };
  const service = await RumService.findOne({ _id: id, ownerId }).select('_id').lean();
  if (!service) return { error: 'RUM Service not found' as const };
  return { ownerId, serviceId: id };
};

// --- List (owner) ---
export const listSourceMaps = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resolved = await resolveService(req);
    if ('error' in resolved) {
      return res.status(resolved.error === 'RUM Service not found' ? 404 : 400).json({ error: resolved.error });
    }
    const maps = await SourceMap.find({ serviceId: resolved.serviceId })
      .select('fileName release size createdAt updatedAt')
      .sort({ updatedAt: -1 })
      .limit(MAX_MAPS_PER_SERVICE)
      .lean();
    res.json(maps);
  } catch (error) {
    next(error);
  }
};

// --- Delete (owner) ---
export const deleteSourceMap = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resolved = await resolveService(req);
    if ('error' in resolved) {
      return res.status(resolved.error === 'RUM Service not found' ? 404 : 400).json({ error: resolved.error });
    }
    const { mapId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(mapId)) return res.status(400).json({ error: 'Invalid map id' });

    const deleted = await SourceMap.findOneAndDelete({ _id: mapId, serviceId: resolved.serviceId });
    if (!deleted) return res.status(404).json({ error: 'Source map not found' });
    res.json({ message: 'Source map deleted' });
  } catch (error) {
    next(error);
  }
};

// --- Symbolicate a stack trace (owner) ---
export const symbolicateRumStack = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resolved = await resolveService(req);
    if ('error' in resolved) {
      return res.status(resolved.error === 'RUM Service not found' ? 404 : 400).json({ error: resolved.error });
    }

    const { stackTrace, release } = req.body || {};
    if (!stackTrace || typeof stackTrace !== 'string') {
      return res.status(400).json({ error: 'stackTrace is required.' });
    }

    const result = await symbolicateStack(resolved.serviceId, stackTrace.slice(0, 50000), release ? String(release) : undefined);
    res.json(result);
  } catch (error) {
    next(error);
  }
};
