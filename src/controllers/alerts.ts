import { Request, Response, NextFunction } from 'express';
import { AlertDestination, AlertPolicy, AlertCondition, AlertIncident } from '../models/Alert';

// --- 1. DESTINATIONS ---
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
    const destinations = await AlertDestination.find({ ownerId: uid }).lean();
    res.json({ destinations });
  } catch (error) { next(error); }
};

// --- 2. POLICIES ---
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
    // Populate destinations to show icons on the UI
    const policies = await AlertPolicy.find({ ownerId: uid })
      .populate('destinations', 'name type')
      .lean();

    // Also attach the number of active conditions and open incidents per policy
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

    const conditions = await AlertCondition.find({ policyId: id }).lean();

    // Get recent incidents
    const incidents = await AlertIncident.find({ policyId: id })
      .sort({ openedAt: -1 })
      .limit(50)
      .populate('conditionId', 'name target')
      .lean();

    res.json({ policy, conditions, incidents });
  } catch (error) { next(error); }
};

// --- 3. CONDITIONS ---
export const createCondition = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { policyId, name, target, query, threshold, frequency } = req.body;

    // Verify policy ownership
    const policy = await AlertPolicy.findOne({ _id: policyId, ownerId: uid });
    if (!policy) return res.status(403).json({ error: "Invalid Policy ID" });

    const condition = await AlertCondition.create({
      ownerId: uid, policyId, name, target, query, threshold, frequency
    });

    res.status(201).json({ condition });
  } catch (error) { next(error); }
};

export const deleteCondition = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = (req as any).user;
    const { id } = req.params;

    await AlertCondition.findOneAndDelete({ _id: id, ownerId: uid });
    // Also clean up associated open incidents so they don't get stuck
    await AlertIncident.deleteMany({ conditionId: id });

    res.json({ success: true });
  } catch (error) { next(error); }
};

// --- 4. INCIDENTS (Acknowledge / Resolve Manually) ---
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

    res.json({ incident });
  } catch (error) { next(error); }
};