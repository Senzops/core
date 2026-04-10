import mongoose, { Schema, Document } from 'mongoose';

export interface ITransaction extends Document {
  ownerId: string;
  paddleTransactionId: string;
  amount: number;
  currency: string;
  status: 'completed' | 'refunded' | 'failed';
  billedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const TransactionSchema = new Schema<ITransaction>(
  {
    ownerId: { type: String, required: true, index: true },
    paddleTransactionId: { type: String, required: true, unique: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    status: { type: String, required: true, default: 'completed' },
    billedAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// Optimize for fetching billing history chronologically
TransactionSchema.index({ ownerId: 1, billedAt: -1 });

export const Transaction = mongoose.model<ITransaction>('Transaction', TransactionSchema);