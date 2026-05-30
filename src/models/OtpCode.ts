import mongoose, { Schema, Document } from 'mongoose';

export interface IOtpCode extends Document {
  email: string;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  createdAt: Date;
}

const OtpCodeSchema = new Schema<IOtpCode>({
  email: { type: String, required: true, index: true },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

OtpCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
OtpCodeSchema.index({ email: 1, createdAt: -1 });

export const OtpCode = mongoose.model<IOtpCode>('OtpCode', OtpCodeSchema);
