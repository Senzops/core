import mongoose, { Schema, Document } from 'mongoose';

/**
 * SourceMap — a gzipped source map uploaded for a RUM service, used to
 * de-minify (symbolicate) error stack traces at view time.
 *
 * The map JSON is stored gzipped as a Buffer (select:false so list queries
 * never pull the large payload). Lookups match on the minified file's basename;
 * `release` distinguishes versions when filenames aren't content-hashed. Maps
 * are uploaded with the service's ingest API key, replaced on re-upload, and
 * bounded per service.
 */
export interface ISourceMap extends Document {
  ownerId: string;
  serviceId: mongoose.Types.ObjectId;
  release: string;
  fileName: string;     // Basename of the minified file, e.g. "main.abc123.js".
  mapGz: Buffer;        // gzip(JSON of the source map).
  size: number;         // Uncompressed byte size of the map JSON.
  createdAt: Date;
  updatedAt: Date;
}

const SourceMapSchema = new Schema<ISourceMap>({
  ownerId: { type: String, required: true, index: true },
  serviceId: { type: Schema.Types.ObjectId, ref: 'RumService', required: true, index: true },
  release: { type: String, required: true, default: 'default' },
  fileName: { type: String, required: true },
  mapGz: { type: Buffer, required: true, select: false },
  size: { type: Number, required: true },
}, { timestamps: true });

// Upsert key — re-uploading the same release+file replaces it.
SourceMapSchema.index({ serviceId: 1, release: 1, fileName: 1 }, { unique: true });
// Lookup by basename, newest first (when release is unknown at symbolication time).
SourceMapSchema.index({ serviceId: 1, fileName: 1, createdAt: -1 });

export const SourceMap = mongoose.model<ISourceMap>('SourceMap', SourceMapSchema);
