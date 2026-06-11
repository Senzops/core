import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { AiConversation } from '../../models/AiConversation';

function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id) && new mongoose.Types.ObjectId(id).toString() === id;
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(100_000),
  provider: z.string().max(50).optional(),
  model: z.string().max(100).optional(),
  trace: z.record(z.unknown()).optional(),
});

const CreateConversationSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  provider: z.string().min(1).max(50).optional(),
  model: z.string().max(100).optional(),
  messages: z.array(MessageSchema).max(50).optional(),
});

const UpdateConversationSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  provider: z.string().min(1).max(50).optional(),
  model: z.string().max(100).optional(),
});

const AppendMessagesSchema = z.object({
  messages: z.array(MessageSchema).min(1).max(50),
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const createConversation = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const ownerId = (req as any).ownerId;
    if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });

    const { title, provider, model, messages } = CreateConversationSchema.parse(req.body);

    const stamped = (messages || []).map((m) => ({ ...m, createdAt: new Date() }));

    const conversation = await AiConversation.create({
      ownerId,
      title: title || 'New Conversation',
      provider: provider || 'webllm',
      modelId: model || '',
      messages: stamped,
      messageCount: stamped.length,
    });

    res.status(201).json({
      message: 'Conversation created',
      conversation: {
        _id: conversation._id,
        title: conversation.title,
        provider: conversation.provider,
        model: conversation.modelId,
        messageCount: conversation.messageCount,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const listConversations = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const ownerId = (req as any).ownerId;
    if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });

    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const [conversations, total] = await Promise.all([
      AiConversation.find({ ownerId })
        .select('title provider modelId messageCount createdAt updatedAt')
        .sort({ updatedAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      AiConversation.countDocuments({ ownerId }),
    ]);

    // Map modelId -> model for API, strip internal modelId field
    const mapped = conversations.map(({ modelId, ...rest }) => ({
      ...rest,
      model: modelId,
    }));

    res.json({ conversations: mapped, total, limit, offset });
  } catch (error) {
    next(error);
  }
};

export const getConversation = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const ownerId = (req as any).ownerId;
    if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid conversation ID' });

    const conversation = await AiConversation.findOne({
      _id: id,
      ownerId,
    }).lean();

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const { modelId, ...rest } = conversation;
    res.json({
      conversation: {
        ...rest,
        model: modelId,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const updateConversation = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const ownerId = (req as any).ownerId;
    if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid conversation ID' });

    const { title, provider, model } = UpdateConversationSchema.parse(req.body);

    const $set: Record<string, any> = {};
    if (title !== undefined) $set.title = title;
    if (provider !== undefined) $set.provider = provider;
    if (model !== undefined) $set.modelId = model;

    if (Object.keys($set).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const conversation = await AiConversation.findOneAndUpdate(
      { _id: id, ownerId },
      { $set },
      { new: true, runValidators: true },
    ).select('title provider modelId messageCount createdAt updatedAt');

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json({
      message: 'Conversation updated',
      conversation: {
        _id: conversation._id,
        title: conversation.title,
        provider: conversation.provider,
        model: conversation.modelId,
        messageCount: conversation.messageCount,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const deleteConversation = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const ownerId = (req as any).ownerId;
    if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid conversation ID' });

    const result = await AiConversation.findOneAndDelete({ _id: id, ownerId });
    if (!result) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json({ message: 'Conversation deleted' });
  } catch (error) {
    next(error);
  }
};

const MAX_MESSAGES_PER_CONVERSATION = 500;

export const appendMessages = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const ownerId = (req as any).ownerId;
    if (!ownerId) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid conversation ID' });

    const { messages } = AppendMessagesSchema.parse(req.body);

    const stamped = messages.map((m) => ({ ...m, createdAt: new Date() }));

    const conversation = await AiConversation.findOneAndUpdate(
      { _id: id, ownerId, messageCount: { $lte: MAX_MESSAGES_PER_CONVERSATION - stamped.length } },
      {
        $push: { messages: { $each: stamped } },
        $inc: { messageCount: stamped.length },
      },
      { new: true, runValidators: true },
    ).select('title provider modelId messageCount updatedAt');

    if (!conversation) {
      const exists = await AiConversation.exists({ _id: id, ownerId });
      if (exists) {
        return res.status(400).json({ error: `Message limit reached (max ${MAX_MESSAGES_PER_CONVERSATION})` });
      }
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Auto-title from first user message if still default
    if (conversation.title === 'New Conversation') {
      const firstUser = stamped.find((m) => m.role === 'user');
      if (firstUser) {
        const autoTitle =
          firstUser.content.length > 80
            ? firstUser.content.slice(0, 77) + '...'
            : firstUser.content;
        await AiConversation.updateOne(
          { _id: id, ownerId, title: 'New Conversation' },
          { $set: { title: autoTitle } },
        );
        conversation.title = autoTitle;
      }
    }

    res.json({
      message: 'Messages appended',
      conversation: {
        _id: conversation._id,
        title: conversation.title,
        provider: conversation.provider,
        model: conversation.modelId,
        messageCount: conversation.messageCount,
        updatedAt: conversation.updatedAt,
      },
    });
  } catch (error) {
    next(error);
  }
};
