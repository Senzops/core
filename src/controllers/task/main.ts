import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { TaskService, TaskRun, TaskMetric } from '../../models/Task';


export const registerTaskService = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Service name is required' });

    const apiKey = crypto.randomBytes(24).toString('hex');
    const service = await TaskService.create({ ownerId: uid, name, apiKey, status: 'offline' });

    res.status(201).json({ message: 'Task Service Registered', serviceId: service._id, apiKey: service.apiKey });
  } catch (error) {
    next(error);
  }
};

export const listTaskServices = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const list = await TaskService.find({ ownerId: uid }).sort({ createdAt: -1 });
    res.json(list);
  } catch (error) {
    next(error);
  }
};

export const deleteTaskService = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;

    const result = await TaskService.findOneAndDelete({ _id: id, ownerId: uid });
    if (!result) return res.status(404).json({ error: 'Service not found' });

    // Background cleanup
    setImmediate(async () => {
      await TaskRun.deleteMany({ serviceId: id });
      await TaskMetric.deleteMany({ serviceId: id });
    });

    res.json({ message: 'Service Deleted' });
  } catch (error) {
    next(error);
  }
};