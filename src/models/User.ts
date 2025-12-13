import mongoose, { Schema, Document } from 'mongoose';

// --- 1. User Schema ---
export interface IUser extends Document {
  firebaseUid: string;
  email: string;
  createdAt: Date;
}

const UserSchema = new Schema<IUser>({
  firebaseUid: { type: String, required: true, unique: true, index: true },
  email: { type: String, required: true },
}, { timestamps: true });

export const User = mongoose.model<IUser>('User', UserSchema);