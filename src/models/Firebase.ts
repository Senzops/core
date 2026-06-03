import mongoose, { Schema, Document } from 'mongoose';

// --- 1. Firebase Service (Configuration) ---
export interface IFirebaseService extends Document {
  ownerId: string;
  name: string;
  projectId: string;
  encryptedServiceAccount: string;
  interval: number;
  status: 'online' | 'offline' | 'error';
  lastCheck?: Date;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

const FirebaseServiceSchema = new Schema<IFirebaseService>({
  ownerId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  projectId: { type: String, required: true },
  encryptedServiceAccount: { type: String, required: true },
  interval: { type: Number, default: 15 },
  status: { type: String, enum: ['online', 'offline', 'error'], default: 'offline' },
  lastCheck: { type: Date },
  errorMessage: { type: String }
}, { timestamps: true });

// --- 2. Firebase Metrics (Time Series) ---
export interface IFirebaseMetric extends Document {
  serviceId: mongoose.Types.ObjectId;
  timestamp: Date;
  auth: {
    totalUsers: number;
    activeUsersDaily: number;
    activeUsersMonthly: number;
    newSignups24h: number;
    disabledUsers: number;
    emailVerifiedCount: number;
    mfaEnrolledCount: number;
    anonymousUsers: number;
    recentSignIns1h: number;
  };
  providers: {
    password: number;
    google: number;
    apple: number;
    phone: number;
    github: number;
    microsoft: number;
    facebook: number;
    twitter: number;
    anonymous: number;
    other: number;
  };
}

const FirebaseMetricSchema = new Schema<IFirebaseMetric>({
  serviceId: { type: Schema.Types.ObjectId, ref: 'FirebaseService', required: true },
  timestamp: { type: Date, required: true },
  auth: {
    totalUsers: { type: Number, default: 0 },
    activeUsersDaily: { type: Number, default: 0 },
    activeUsersMonthly: { type: Number, default: 0 },
    newSignups24h: { type: Number, default: 0 },
    disabledUsers: { type: Number, default: 0 },
    emailVerifiedCount: { type: Number, default: 0 },
    mfaEnrolledCount: { type: Number, default: 0 },
    anonymousUsers: { type: Number, default: 0 },
    recentSignIns1h: { type: Number, default: 0 }
  },
  providers: {
    password: { type: Number, default: 0 },
    google: { type: Number, default: 0 },
    apple: { type: Number, default: 0 },
    phone: { type: Number, default: 0 },
    github: { type: Number, default: 0 },
    microsoft: { type: Number, default: 0 },
    facebook: { type: Number, default: 0 },
    twitter: { type: Number, default: 0 },
    anonymous: { type: Number, default: 0 },
    other: { type: Number, default: 0 }
  }
});

FirebaseMetricSchema.index({ serviceId: 1, timestamp: 1 });
FirebaseMetricSchema.index({ timestamp: 1 }, { expireAfterSeconds: 604800 });

// --- 3. Firebase Auth Snapshot (Upserted per service, recent user activity) ---
export interface IFirebaseAuthSnapshot extends Document {
  serviceId: mongoose.Types.ObjectId;
  lastCheck: Date;
  recentUsers: {
    uid: string;
    email?: string;
    displayName?: string;
    createdAt?: Date;
    lastSignIn?: Date;
    providers: string[];
    mfaEnabled: boolean;
    disabled: boolean;
    emailVerified: boolean;
  }[];
}

const FirebaseAuthSnapshotSchema = new Schema<IFirebaseAuthSnapshot>({
  serviceId: { type: Schema.Types.ObjectId, ref: 'FirebaseService', required: true, unique: true },
  lastCheck: { type: Date, required: true },
  recentUsers: [{
    uid: String,
    email: String,
    displayName: String,
    createdAt: Date,
    lastSignIn: Date,
    providers: [String],
    mfaEnabled: Boolean,
    disabled: Boolean,
    emailVerified: Boolean
  }]
});

export const FirebaseService = mongoose.model<IFirebaseService>('FirebaseService', FirebaseServiceSchema);
export const FirebaseMetric = mongoose.model<IFirebaseMetric>('FirebaseMetric', FirebaseMetricSchema);
export const FirebaseAuthSnapshot = mongoose.model<IFirebaseAuthSnapshot>('FirebaseAuthSnapshot', FirebaseAuthSnapshotSchema);
