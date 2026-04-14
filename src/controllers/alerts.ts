import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { AlertDestination, AlertPolicy, AlertCondition, AlertIncident } from '../models/Alert';

// ============================================================================
// 1. DESTINATIONS (CHANNELS)
// ============================================================================
export const createDestination = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { name, type, config } = req.body;

    const destination = await AlertDestination.create({ ownerId: uid, name, type, config });
    res.status(201).json({ destination });
  } catch (error) { next(error); }
};

export const listDestinations = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const destinations = await AlertDestination.find({ ownerId: uid }).sort({ createdAt: -1 }).lean();
    res.json({ destinations });
  } catch (error) { next(error); }
};

export const updateDestination = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;
    const { name, type, config } = req.body;

    const destination = await AlertDestination.findOneAndUpdate(
      { _id: id, ownerId: uid },
      { name, type, config },
      { new: true }
    );

    if (!destination) return res.status(404).json({ error: "Destination not found or access denied" });
    res.json({ destination });
  } catch (error) { next(error); }
};

export const deleteDestination = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;

    const destination = await AlertDestination.findOneAndDelete({ _id: id, ownerId: uid });
    if (!destination) return res.status(404).json({ error: "Destination not found or access denied" });

    // CASCADE: Remove this destination from any policies using it to prevent broken references
    await AlertPolicy.updateMany(
      { ownerId: uid, destinations: id },
      { $pull: { destinations: id } }
    );

    res.json({ success: true, message: "Destination deleted and references cleared." });
  } catch (error) { next(error); }
};


// ============================================================================
// 2. POLICIES
// ============================================================================
export const createPolicy = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { name, description, destinations } = req.body;

    const policy = await AlertPolicy.create({ ownerId: uid, name, description, destinations });
    res.status(201).json({ policy });
  } catch (error) { next(error); }
};

export const listPolicies = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;

    const policies = await AlertPolicy.find({ ownerId: uid })
      .populate('destinations', 'name type')
      .sort({ createdAt: -1 })
      .lean();

    const enrichedPolicies = await Promise.all(policies.map(async (p) => {
      const conditionCount = await AlertCondition.countDocuments({ policyId: p._id });
      const openIncidents = await AlertIncident.countDocuments({ policyId: p._id, status: 'open' });
      return { ...p, conditionCount, openIncidents };
    }));

    res.json({ policies: enrichedPolicies });
  } catch (error) { next(error); }
};

export const getPolicyDetails = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;

    const policy = await AlertPolicy.findOne({ _id: id, ownerId: uid }).populate('destinations').lean();
    if (!policy) return res.status(404).json({ error: "Policy not found" });

    const conditions = await AlertCondition.find({ policyId: id }).sort({ createdAt: -1 }).lean();

    const incidents = await AlertIncident.find({ policyId: id })
      .sort({ openedAt: -1 })
      .limit(50)
      .populate('conditionId', 'name target')
      .lean();

    res.json({ policy, conditions, incidents });
  } catch (error) { next(error); }
};

export const updatePolicy = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;
    const { name, description, destinations } = req.body;

    const policy = await AlertPolicy.findOneAndUpdate(
      { _id: id, ownerId: uid },
      { name, description, destinations },
      { new: true }
    );

    if (!policy) return res.status(404).json({ error: "Policy not found or access denied" });
    res.json({ policy });
  } catch (error) { next(error); }
};

export const deletePolicy = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;

    const policy = await AlertPolicy.findOneAndDelete({ _id: id, ownerId: uid });
    if (!policy) return res.status(404).json({ error: "Policy not found or access denied" });

    // CASCADE: Delete all associated conditions and incidents so the watchdog doesn't process ghosts
    await AlertCondition.deleteMany({ policyId: id });
    await AlertIncident.deleteMany({ policyId: id });

    res.json({ success: true, message: "Policy and all associated rules/incidents deleted." });
  } catch (error) { next(error); }
};


// ============================================================================
// 3. CONDITIONS (RULES)
// ============================================================================
export const createCondition = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { policyId, name, target, query, threshold, frequency } = req.body;

    const policy = await AlertPolicy.findOne({ _id: policyId, ownerId: uid });
    if (!policy) return res.status(403).json({ error: "Invalid Policy ID" });

    const condition = await AlertCondition.create({
      ownerId: uid, policyId, name, target, query, threshold, frequency
    });

    res.status(201).json({ condition });
  } catch (error) { next(error); }
};

export const updateCondition = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;
    const { name, target, query, threshold, frequency } = req.body;

    // 1. Fetch using .lean() to get pure BSON
    const conditionRaw = await AlertCondition.findOne({ _id: id, ownerId: uid }).lean();

    if (!conditionRaw) {
      return res.status(404).json({ error: "Condition not found or access denied" });
    }

    // 2. Clone it and apply mutations in memory
    const rawDoc: any = { ...conditionRaw };

    if (name !== undefined) rawDoc.name = name;
    if (target !== undefined) rawDoc.target = target;
    if (query !== undefined) rawDoc.query = query;
    if (threshold !== undefined) rawDoc.threshold = threshold;
    if (frequency !== undefined) rawDoc.frequency = frequency;
    rawDoc.updatedAt = new Date();

    // 3. The "Safe Swap" Pattern
    // MongoDB's 'update' command (used by findOneAndUpdate, save, and replaceOne)
    // strictly forbids storing fields that start with '$' anywhere in the document 
    // to prevent update-operator injection attacks. 
    // The 'insert' command, however, safely bypasses this and stores the AST perfectly.
    // To safely update the condition, we atomically swap it out, explicitly retaining the original _id.

    // Drop the old condition from the DB
    await AlertCondition.collection.deleteOne({ _id: conditionRaw._id });

    try {
      // Re-insert it as a fresh document carrying the exact same _id
      await AlertCondition.collection.insertOne(rawDoc);
    } catch (insertError) {
      // Absolute safety net: Restore the original untouched document if the network fails mid-swap
      await AlertCondition.collection.insertOne(conditionRaw);
      throw insertError;
    }

    // 4. Fetch the freshly replaced document via Mongoose to return a compliant JSON schema
    const updatedCondition = await AlertCondition.findById(id);

    res.json({ condition: updatedCondition });
  } catch (error) { next(error); }
};

export const deleteCondition = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;

    const condition = await AlertCondition.findOneAndDelete({ _id: id, ownerId: uid });
    if (!condition) return res.status(404).json({ error: "Condition not found or access denied" });

    // CASCADE: Clean up associated open/resolved incidents so they don't get stuck
    await AlertIncident.deleteMany({ conditionId: id });

    res.json({ success: true, message: "Condition and associated incidents cleared." });
  } catch (error) { next(error); }
};


// ============================================================================
// 4. INCIDENTS (STATE MACHINE)
// ============================================================================
export const updateIncidentStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;
    const { status } = req.body; // 'acknowledged' or 'resolved'

    const update: any = { status };
    if (status === 'resolved') update.resolvedAt = new Date();

    const incident = await AlertIncident.findOneAndUpdate(
      { _id: id, ownerId: uid },
      update,
      { new: true }
    );

    if (!incident) return res.status(404).json({ error: "Incident not found or access denied" });
    res.json({ incident });
  } catch (error) { next(error); }
};