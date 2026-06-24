// ============================================================================
// Funnel analysis engine
// ----------------------------------------------------------------------------
// Computes per-visitor, ordered conversion through a funnel's steps within a
// time window. The heavy lifting runs as a single MongoDB aggregation:
//
//   1. Coarse $or prefilter (index-friendly) narrows to events that can match
//      any step, bounded by webId + time window.
//   2. Each surviving event is tagged with the array of step indices it
//      satisfies, then unwound so one visitor's matches become an ordered list.
//   3. $reduce walks that ordered list and counts the longest in-order prefix
//      of steps the visitor completed ("reached").
//   4. Group by `reached` so at most N+1 rows return to Node.
//
// Conversion at step i = visitors who reached at least i+1 steps, derived by a
// cheap cumulative sum. This keeps transfer and memory bounded regardless of
// traffic volume.
// ============================================================================

import mongoose from 'mongoose';
import { WebEvent } from '../../models/Web';
import { IFunnelStep } from '../../models/Funnel';

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Query condition (used in the indexed prefilter $match) for a single step.
const stepQueryCondition = (step: IFunnelStep): Record<string, any> => {
  if (step.type === 'event') {
    return { type: 'event', eventName: step.value };
  }
  switch (step.match) {
    case 'startsWith':
      return { type: 'pageview', path: { $regex: `^${escapeRegex(step.value)}` } };
    case 'contains':
      return { type: 'pageview', path: { $regex: escapeRegex(step.value) } };
    default:
      return { type: 'pageview', path: step.value };
  }
};

// Aggregation expression that is true when a document satisfies a single step.
const stepMatchExpr = (step: IFunnelStep): Record<string, any> => {
  if (step.type === 'event') {
    return { $and: [{ $eq: ['$type', 'event'] }, { $eq: ['$eventName', step.value] }] };
  }
  switch (step.match) {
    case 'startsWith':
      return { $and: [{ $eq: ['$type', 'pageview'] }, { $eq: [{ $indexOfCP: ['$path', step.value] }, 0] }] };
    case 'contains':
      return { $and: [{ $eq: ['$type', 'pageview'] }, { $gte: [{ $indexOfCP: ['$path', step.value] }, 0] }] };
    default:
      return { $and: [{ $eq: ['$type', 'pageview'] }, { $eq: ['$path', step.value] }] };
  }
};

export interface FunnelStepResult {
  step: number;
  type: string;
  value: string;
  label?: string;
  visitors: number;
  conversionFromStart: number; // % of step-0 visitors that reached this step
  conversionFromPrev: number;  // % of previous step's visitors that reached this step
  dropOff: number;             // visitors lost vs the previous step
}

export interface FunnelAnalysis {
  results: FunnelStepResult[];
  totalEntered: number;    // visitors that completed step 0
  totalConverted: number;  // visitors that completed the final step
  overallConversion: number;
}

interface AnalyzeParams {
  webId: mongoose.Types.ObjectId;
  steps: IFunnelStep[];
  startDate: Date;
  endDate: Date;
}

export async function analyzeFunnelSteps(params: AnalyzeParams): Promise<FunnelAnalysis> {
  const { webId, steps, startDate, endDate } = params;
  const N = steps.length;

  // Tag each event with the indices of every step it satisfies.
  const stepMatchesArray = {
    $concatArrays: steps.map((s, i) => ({ $cond: [stepMatchExpr(s), [i], []] })),
  };

  const pipeline: mongoose.PipelineStage[] = [
    {
      $match: {
        webId,
        createdAt: { $gte: startDate, $lte: endDate },
        $or: steps.map(stepQueryCondition),
      },
    },
    { $addFields: { _sm: stepMatchesArray } },
    { $match: { $expr: { $gt: [{ $size: '$_sm' }, 0] } } },
    { $unwind: '$_sm' },
    { $sort: { visitorId: 1, createdAt: 1 } },
    { $group: { _id: '$visitorId', seq: { $push: '$_sm' } } },
    {
      $addFields: {
        reached: {
          $reduce: {
            input: '$seq',
            initialValue: 0,
            in: { $cond: [{ $eq: ['$$this', '$$value'] }, { $add: ['$$value', 1] }, '$$value'] },
          },
        },
      },
    },
    { $match: { reached: { $gt: 0 } } },
    { $group: { _id: '$reached', visitors: { $sum: 1 } } },
  ];

  // allowDiskUse: the per-visitor sort can exceed the 100MB in-memory limit on
  // high-traffic sites; spilling to disk keeps the query robust rather than failing.
  const grouped: Array<{ _id: number; visitors: number }> = await WebEvent.aggregate(pipeline, { allowDiskUse: true });

  // reached -> count, then cumulative: stepVisitors[i] = sum of counts where reached >= i+1.
  const reachedMap = new Map<number, number>();
  for (const row of grouped) reachedMap.set(row._id, row.visitors);

  const stepVisitors: number[] = new Array(N).fill(0);
  for (let i = 0; i < N; i++) {
    let sum = 0;
    for (const [reached, count] of reachedMap) {
      if (reached >= i + 1) sum += count;
    }
    stepVisitors[i] = sum;
  }

  const results: FunnelStepResult[] = steps.map((s, i) => {
    const visitors = stepVisitors[i];
    const prev = i === 0 ? visitors : stepVisitors[i - 1];
    return {
      step: i,
      type: s.type,
      value: s.value,
      label: s.label,
      visitors,
      conversionFromStart: stepVisitors[0] > 0 ? (visitors / stepVisitors[0]) * 100 : 0,
      conversionFromPrev: i === 0 ? 100 : prev > 0 ? (visitors / prev) * 100 : 0,
      dropOff: i === 0 ? 0 : Math.max(0, prev - visitors),
    };
  });

  const totalEntered = stepVisitors[0] || 0;
  const totalConverted = stepVisitors[N - 1] || 0;

  return {
    results,
    totalEntered,
    totalConverted,
    overallConversion: totalEntered > 0 ? (totalConverted / totalEntered) * 100 : 0,
  };
}
