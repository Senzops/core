import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import {
  AlertDestination,
  AlertPolicy,
  AlertCondition,
  AlertIncident,
  AlertSilence,
  getNextIncidentNumber,
  ITimelineEvent
} from '../models/Alert';
import { enqueueIncidentAnalysis } from '../lib/aiQueue';
import { checkAiAnalysisAccess } from '../middlewares/planGate';

// ============================================================================
// 1. DESTINATIONS (Notification Channels)
// ============================================================================
export const createDestination = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { name, type, config } = req.body;

    if (!name || !type || !config) {
      return res.status(400).json({ error: 'name, type, and config are required' });
    }

    if (type === 'email' && (!config.emails || !Array.isArray(config.emails) || config.emails.length === 0)) {
      return res.status(400).json({ error: 'Email destinations require at least one email address' });
    }

    if (['slack', 'discord', 'webhook'].includes(type) && !config.webhookUrl) {
      return res.status(400).json({ error: `${type} destinations require a webhookUrl` });
    }

    const destination = await AlertDestination.create({ ownerId, name, type, config });
    res.status(201).json({ destination });
  } catch (error) { next(error); }
};

export const listDestinations = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const destinations = await AlertDestination.find({ ownerId }).sort({ createdAt: -1 }).lean();
    res.json({ destinations });
  } catch (error) { next(error); }
};

export const updateDestination = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const { name, type, config } = req.body;

    const destination = await AlertDestination.findOneAndUpdate(
      { _id: id, ownerId },
      { name, type, config },
      { new: true }
    );

    if (!destination) return res.status(404).json({ error: 'Destination not found or access denied' });
    res.json({ destination });
  } catch (error) { next(error); }
};

export const deleteDestination = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const destination = await AlertDestination.findOneAndDelete({ _id: id, ownerId });
    if (!destination) return res.status(404).json({ error: 'Destination not found or access denied' });

    await AlertPolicy.updateMany(
      { ownerId, destinations: id },
      { $pull: { destinations: id } }
    );

    res.json({ success: true, message: 'Destination deleted and references cleared.' });
  } catch (error) { next(error); }
};


// ============================================================================
// 2. POLICIES
// ============================================================================
export const createPolicy = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { name, description, destinations } = req.body;

    if (!name) return res.status(400).json({ error: 'Policy name is required' });

    const policy = await AlertPolicy.create({ ownerId, name, description, destinations });
    res.status(201).json({ policy });
  } catch (error) { next(error); }
};

export const listPolicies = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;

    const policies = await AlertPolicy.find({ ownerId })
      .populate('destinations', 'name type')
      .sort({ createdAt: -1 })
      .lean();

    const enrichedPolicies = await Promise.all(policies.map(async (p) => {
      const [conditionCount, openIncidents, criticalIncidents] = await Promise.all([
        AlertCondition.countDocuments({ policyId: p._id }),
        AlertIncident.countDocuments({ policyId: p._id, status: 'open' }),
        AlertIncident.countDocuments({ policyId: p._id, status: 'open', severity: 'critical' })
      ]);
      return { ...p, conditionCount, openIncidents, criticalIncidents };
    }));

    res.json({ policies: enrichedPolicies });
  } catch (error) { next(error); }
};

export const getPolicyDetails = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const policy = await AlertPolicy.findOne({ _id: id, ownerId }).populate('destinations').lean();
    if (!policy) return res.status(404).json({ error: 'Policy not found' });

    const conditions = await AlertCondition.find({ policyId: id }).sort({ createdAt: -1 }).lean();

    const incidents = await AlertIncident.find({ policyId: id })
      .sort({ openedAt: -1 })
      .limit(100)
      .populate('conditionId', 'name target severity')
      .lean();

    res.json({ policy, conditions, incidents });
  } catch (error) { next(error); }
};

export const updatePolicy = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const { name, description, destinations } = req.body;

    const policy = await AlertPolicy.findOneAndUpdate(
      { _id: id, ownerId },
      { name, description, destinations },
      { new: true }
    );

    if (!policy) return res.status(404).json({ error: 'Policy not found or access denied' });
    res.json({ policy });
  } catch (error) { next(error); }
};

export const deletePolicy = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const policy = await AlertPolicy.findOneAndDelete({ _id: id, ownerId });
    if (!policy) return res.status(404).json({ error: 'Policy not found or access denied' });

    await Promise.all([
      AlertCondition.deleteMany({ policyId: id }),
      AlertIncident.deleteMany({ policyId: id })
    ]);

    res.json({ success: true, message: 'Policy and all associated rules/incidents deleted.' });
  } catch (error) { next(error); }
};


// ============================================================================
// 3. CONDITIONS (Evaluation Rules)
// ============================================================================
export const createCondition = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { policyId, name, description, target, query, threshold, severity, frequency, labels } = req.body;

    if (!policyId || !name || !target || !threshold) {
      return res.status(400).json({ error: 'policyId, name, target, and threshold are required' });
    }

    const policy = await AlertPolicy.findOne({ _id: policyId, ownerId });
    if (!policy) return res.status(403).json({ error: 'Invalid Policy ID' });

    const condition = await AlertCondition.create({
      ownerId, policyId, name, description, target, query,
      threshold, severity: severity || 'high', frequency, labels
    });

    res.status(201).json({ condition });
  } catch (error) { next(error); }
};

export const updateCondition = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const { name, description, target, query, threshold, severity, frequency, labels, isActive } = req.body;

    const conditionRaw = await AlertCondition.findOne({ _id: id, ownerId }).lean();
    if (!conditionRaw) {
      return res.status(404).json({ error: 'Condition not found or access denied' });
    }

    // Safe Swap Pattern: prevents MongoDB $-operator injection via update commands
    const rawDoc: any = { ...conditionRaw };

    if (name !== undefined) rawDoc.name = name;
    if (description !== undefined) rawDoc.description = description;
    if (target !== undefined) rawDoc.target = target;
    if (query !== undefined) rawDoc.query = query;
    if (threshold !== undefined) rawDoc.threshold = threshold;
    if (severity !== undefined) rawDoc.severity = severity;
    if (frequency !== undefined) rawDoc.frequency = frequency;
    if (labels !== undefined) rawDoc.labels = labels;
    if (isActive !== undefined) rawDoc.isActive = isActive;
    rawDoc.updatedAt = new Date();

    await AlertCondition.collection.deleteOne({ _id: conditionRaw._id });

    try {
      await AlertCondition.collection.insertOne(rawDoc);
    } catch (insertError) {
      await AlertCondition.collection.insertOne(conditionRaw);
      throw insertError;
    }

    const updatedCondition = await AlertCondition.findById(id);
    res.json({ condition: updatedCondition });
  } catch (error) { next(error); }
};

export const deleteCondition = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const condition = await AlertCondition.findOneAndDelete({ _id: id, ownerId });
    if (!condition) return res.status(404).json({ error: 'Condition not found or access denied' });

    await AlertIncident.deleteMany({ conditionId: id });

    res.json({ success: true, message: 'Condition and associated incidents cleared.' });
  } catch (error) { next(error); }
};

export const muteCondition = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const { durationMins } = req.body;

    if (!durationMins || durationMins < 1) {
      return res.status(400).json({ error: 'durationMins must be a positive integer' });
    }

    const muteUntil = new Date(Date.now() + durationMins * 60 * 1000);

    const condition = await AlertCondition.findOneAndUpdate(
      { _id: id, ownerId },
      { muteUntil },
      { new: true }
    );

    if (!condition) return res.status(404).json({ error: 'Condition not found or access denied' });
    res.json({ condition, muteUntil });
  } catch (error) { next(error); }
};

export const unmuteCondition = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const condition = await AlertCondition.findOneAndUpdate(
      { _id: id, ownerId },
      { muteUntil: null },
      { new: true }
    );

    if (!condition) return res.status(404).json({ error: 'Condition not found or access denied' });
    res.json({ condition });
  } catch (error) { next(error); }
};

export const testCondition = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { target, query, threshold } = req.body;

    if (!target || !threshold) {
      return res.status(400).json({ error: 'target and threshold are required for testing' });
    }

    // Dynamically import the evaluation logic
    const { evaluateConditionDryRun } = await import('../worker/alertWatchdog');
    const result = await evaluateConditionDryRun(ownerId, target, query || [], threshold);

    res.json(result);
  } catch (error) { next(error); }
};


// ============================================================================
// 4. INCIDENTS (Full Lifecycle)
// ============================================================================
export const listIncidents = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { status, severity, policyId, limit = '50', offset = '0', sort = '-openedAt' } = req.query;

    const filter: any = { ownerId };
    if (status && status !== 'all') filter.status = status;
    if (severity && severity !== 'all') filter.severity = severity;
    if (policyId) filter.policyId = policyId;

    const sortField = (sort as string).startsWith('-') ? (sort as string).slice(1) : sort as string;
    const sortOrder = (sort as string).startsWith('-') ? -1 : 1;

    const [incidents, total, statusCounts] = await Promise.all([
      AlertIncident.find(filter)
        .sort({ [sortField]: sortOrder })
        .skip(Number(offset))
        .limit(Math.min(Number(limit), 200))
        .populate('conditionId', 'name target severity')
        .populate('policyId', 'name')
        .lean(),
      AlertIncident.countDocuments(filter),
      AlertIncident.aggregate([
        { $match: { ownerId } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ])
    ]);

    const counts = {
      open: 0,
      acknowledged: 0,
      resolved: 0,
      ...Object.fromEntries(statusCounts.map((s: any) => [s._id, s.count]))
    };

    res.json({ incidents, total, counts });
  } catch (error) { next(error); }
};

export const getIncidentDetail = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const incident = await AlertIncident.findOne({ _id: id, ownerId })
      .populate('conditionId', 'name target severity threshold query description labels')
      .populate('policyId', 'name description destinations')
      .lean();

    if (!incident) return res.status(404).json({ error: 'Incident not found' });

    // Populate policy destinations
    if (incident.policyId && (incident.policyId as any).destinations) {
      const destinations = await AlertDestination.find({
        _id: { $in: (incident.policyId as any).destinations }
      }).select('name type').lean();
      (incident.policyId as any).destinations = destinations;
    }

    res.json({ incident });
  } catch (error) { next(error); }
};

export const updateIncidentStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const { status } = req.body;

    if (!['acknowledged', 'resolved'].includes(status)) {
      return res.status(400).json({ error: 'Status must be acknowledged or resolved' });
    }

    const incident = await AlertIncident.findOne({ _id: id, ownerId });
    if (!incident) return res.status(404).json({ error: 'Incident not found or access denied' });

    if (incident.status === 'resolved' && status !== 'resolved') {
      return res.status(400).json({ error: 'Cannot modify a resolved incident' });
    }

    const now = new Date();
    const timelineEntry: ITimelineEvent = {
      type: status as any,
      message: status === 'acknowledged'
        ? 'Incident acknowledged by operator'
        : 'Incident manually resolved by operator',
      userId: (req as any).user?.uid,
      timestamp: now
    };

    incident.status = status;
    incident.timeline.push(timelineEntry);

    if (status === 'acknowledged' && !incident.acknowledgedAt) {
      incident.acknowledgedAt = now;
    }
    if (status === 'resolved') {
      incident.resolvedAt = now;
    }

    await incident.save();
    res.json({ incident });
  } catch (error) { next(error); }
};

export const updateIncidentSeverity = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const { severity } = req.body;

    if (!['critical', 'high', 'medium', 'low', 'info'].includes(severity)) {
      return res.status(400).json({ error: 'Invalid severity level' });
    }

    const incident = await AlertIncident.findOne({ _id: id, ownerId });
    if (!incident) return res.status(404).json({ error: 'Incident not found or access denied' });

    const oldSeverity = incident.severity;
    incident.severity = severity;
    incident.timeline.push({
      type: 'severity_changed',
      message: `Severity changed from ${oldSeverity} to ${severity}`,
      userId: (req as any).user?.uid,
      timestamp: new Date()
    });

    await incident.save();
    res.json({ incident });
  } catch (error) { next(error); }
};

export const assignIncident = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const { assigneeId } = req.body;

    const incident = await AlertIncident.findOne({ _id: id, ownerId });
    if (!incident) return res.status(404).json({ error: 'Incident not found or access denied' });

    incident.assigneeId = assigneeId || undefined;
    incident.timeline.push({
      type: 'assigned',
      message: assigneeId ? `Incident assigned to ${assigneeId}` : 'Incident unassigned',
      userId: (req as any).user?.uid,
      timestamp: new Date()
    });

    await incident.save();
    res.json({ incident });
  } catch (error) { next(error); }
};

export const addIncidentNote = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;
    const { content } = req.body;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Note content is required' });
    }

    if (content.length > 2000) {
      return res.status(400).json({ error: 'Note content must be under 2000 characters' });
    }

    const incident = await AlertIncident.findOne({ _id: id, ownerId });
    if (!incident) return res.status(404).json({ error: 'Incident not found or access denied' });

    incident.timeline.push({
      type: 'note',
      message: content.trim(),
      userId: (req as any).user?.uid,
      timestamp: new Date()
    });

    await incident.save();
    res.json({ incident });
  } catch (error) { next(error); }
};

export const bulkUpdateIncidents = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { incidentIds, action } = req.body;

    if (!Array.isArray(incidentIds) || incidentIds.length === 0) {
      return res.status(400).json({ error: 'incidentIds array is required' });
    }

    if (!['acknowledge', 'resolve'].includes(action)) {
      return res.status(400).json({ error: 'action must be acknowledge or resolve' });
    }

    if (incidentIds.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 incidents per bulk operation' });
    }

    const now = new Date();
    const status = action === 'acknowledge' ? 'acknowledged' : 'resolved';

    const statusFilter = action === 'acknowledge' ? { status: 'open' } : { status: { $in: ['open', 'acknowledged'] } };

    const timelineEntry = {
      type: status,
      message: `Incident bulk ${status} by operator`,
      userId: (req as any).user?.uid,
      timestamp: now
    };

    const update: any = {
      status,
      $push: { timeline: timelineEntry }
    };

    if (status === 'acknowledged') update.acknowledgedAt = now;
    if (status === 'resolved') update.resolvedAt = now;

    const result = await AlertIncident.updateMany(
      { _id: { $in: incidentIds }, ownerId, ...statusFilter },
      update
    );

    res.json({ success: true, modifiedCount: result.modifiedCount });
  } catch (error) { next(error); }
};


// ============================================================================
// 5. AI INCIDENT ANALYSIS
// ============================================================================

export const getIncidentAnalysis = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const incident = await AlertIncident.findOne({ _id: id, ownerId })
      .select('aiAnalysis incidentNumber title severity status')
      .lean();

    if (!incident) return res.status(404).json({ error: 'Incident not found' });

    res.json({
      incidentId: incident._id,
      analysis: incident.aiAnalysis || null,
    });
  } catch (error) { next(error); }
};

export const triggerIncidentAnalysis = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    // Plan gate check
    const access = await checkAiAnalysisAccess(ownerId);
    if (!access.allowed) {
      return res.status(403).json({
        error: 'Plan upgrade required',
        requiredPlan: 'business',
        currentPlan: access.plan,
        message: 'AI Incident Analysis requires the Business plan or higher.',
      });
    }

    const incident = await AlertIncident.findOne({ _id: id, ownerId })
      .populate('conditionId', 'name description target query threshold severity labels policyId')
      .lean();

    if (!incident) return res.status(404).json({ error: 'Incident not found' });

    // Prevent re-analysis if one is already pending
    if (incident.aiAnalysis?.status === 'pending') {
      return res.status(409).json({ error: 'Analysis already in progress' });
    }

    const condition = incident.conditionId as any;
    if (!condition) return res.status(400).json({ error: 'Incident condition not found' });

    // Mark as pending immediately
    await AlertIncident.findByIdAndUpdate(id, {
      aiAnalysis: {
        status: 'pending',
        summary: '',
        findings: { rootCause: '', affectedServices: [], correlatedEvents: [], recommendedActions: [] },
        confidence: 'low',
        toolCallsUsed: 0,
        tokensUsed: { input: 0, output: 0 },
        model: '',
        analyzedAt: null,
        durationMs: 0,
      },
    });

    // Enqueue analysis — force: true clears any stale completed/failed job
    // so BullMQ's jobId deduplication doesn't silently discard the retry.
    await enqueueIncidentAnalysis({
      incidentId: id,
      ownerId,
      conditionName: condition.name,
      conditionDescription: condition.description || '',
      target: condition.target,
      triggerValue: incident.triggerValue,
      threshold: condition.threshold,
      severity: condition.severity || incident.severity,
      labels: condition.labels || [],
      title: incident.title,
      policyId: condition.policyId?.toString() || incident.policyId?.toString(),
      query: condition.query || undefined,
    }, { force: true });

    res.json({ success: true, message: 'AI analysis enqueued', status: 'pending' });
  } catch (error) { next(error); }
};


// ============================================================================
// 6. SILENCE WINDOWS (Maintenance / Muting)
// ============================================================================
export const createSilence = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { name, reason, startsAt, endsAt, scope } = req.body;

    if (!name || !reason || !startsAt || !endsAt) {
      return res.status(400).json({ error: 'name, reason, startsAt, and endsAt are required' });
    }

    const start = new Date(startsAt);
    const end = new Date(endsAt);

    if (end <= start) {
      return res.status(400).json({ error: 'endsAt must be after startsAt' });
    }

    if (end <= new Date()) {
      return res.status(400).json({ error: 'endsAt must be in the future' });
    }

    const silence = await AlertSilence.create({
      ownerId, name, reason,
      startsAt: start, endsAt: end,
      scope: scope || {},
      createdBy: (req as any).user?.uid
    });

    res.status(201).json({ silence });
  } catch (error) { next(error); }
};

export const listSilences = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { active } = req.query;

    const filter: any = { ownerId };
    if (active === 'true') {
      const now = new Date();
      filter.startsAt = { $lte: now };
      filter.endsAt = { $gt: now };
    }

    const silences = await AlertSilence.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ silences });
  } catch (error) { next(error); }
};

export const deleteSilence = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = (req as any).ownerId;
    const { id } = req.params;

    const silence = await AlertSilence.findOneAndDelete({ _id: id, ownerId });
    if (!silence) return res.status(404).json({ error: 'Silence window not found or access denied' });

    res.json({ success: true, message: 'Silence window cancelled.' });
  } catch (error) { next(error); }
};
