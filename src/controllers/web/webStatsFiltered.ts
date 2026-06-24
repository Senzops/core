// ============================================================================
// Filtered (segmented) Web Analytics stats
// ----------------------------------------------------------------------------
// When the dashboard carries one or more segmentation filters, the pre-
// aggregated WebMetric maps (which are single-dimensional) cannot answer the
// query, so every panel is recomputed from the raw WebEvent firehose with the
// filter match applied. This is the deliberate "slow path": it only runs when a
// user actively drills in, and is bounded by the time range + plan retention.
// The unfiltered path in webStats.ts is untouched and stays on WebMetric.
//
// The returned payload is byte-compatible with the unfiltered response so the
// frontend renders identically with or without filters.
// ============================================================================

import mongoose from 'mongoose';
import { WebEvent } from '../../models/Web';
import { fillTimeGaps } from '../../utils/timeRange';

const WEB_GRAPH_DEFAULTS = { views: 0, visitors: 0 };
const DAY_LABELS = ['', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Computes just the overview KPIs (views / unique visitors / avg duration /
 * bounce rate) for an arbitrary window. Used for period-over-period comparison;
 * works with or without a segmentation filter (all four KPIs are raw-derived).
 */
export async function computeWebOverview(
  webId: mongoose.Types.ObjectId,
  startDate: Date,
  endDate: Date,
  filterMatch: Record<string, any> = {}
) {
  const pv = { webId, type: 'pageview', createdAt: { $gte: startDate, $lte: endDate }, ...filterMatch };

  const [uniqueVisitors, sessionStats] = await Promise.all([
    WebEvent.distinct('visitorId', pv),
    WebEvent.aggregate([
      { $match: pv },
      { $group: { _id: '$sessionId', pageViews: { $sum: 1 }, duration: { $sum: '$duration' } } },
      {
        $group: {
          _id: null,
          totalSessions: { $sum: 1 },
          bounces: { $sum: { $cond: [{ $eq: ['$pageViews', 1] }, 1, 0] } },
          totalDuration: { $sum: '$duration' },
          totalPageViews: { $sum: '$pageViews' },
        },
      },
      {
        $project: {
          totalPageViews: 1,
          bounceRate: { $cond: [{ $eq: ['$totalSessions', 0] }, 0, { $multiply: [{ $divide: ['$bounces', '$totalSessions'] }, 100] }] },
          avgDuration: { $cond: [{ $eq: ['$totalSessions', 0] }, 0, { $divide: ['$totalDuration', '$totalSessions'] }] },
        },
      },
    ]),
  ]);

  const s = sessionStats[0] || { totalPageViews: 0, bounceRate: 0, avgDuration: 0 };
  return {
    totalViews: s.totalPageViews,
    uniqueVisitors: uniqueVisitors.length,
    avgDuration: s.avgDuration,
    bounceRate: s.bounceRate,
  };
}

interface FilteredStatsParams {
  webIdObj: any;
  startDate: Date;
  endDate: Date;
  bucketFormat: string;
  resolved: any;
  filterMatch: Record<string, any>;
}

export async function computeFilteredWebStats(params: FilteredStatsParams) {
  const { webIdObj, startDate, endDate, bucketFormat, resolved, filterMatch } = params;

  const inWindow = { $gte: startDate, $lte: endDate };
  const base = { webId: webIdObj, createdAt: inWindow, ...filterMatch };
  const pv = { ...base, type: 'pageview' };
  const ev = { ...base, type: 'event' };

  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  const liveMatch = { webId: webIdObj, ...filterMatch, createdAt: { $gte: fiveMinutesAgo } };

  // Top-N breakdown of a single field over a given match.
  const dim = (match: any, field: string, limit = 10) =>
    WebEvent.aggregate([
      { $match: match },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      { $match: { _id: { $ne: null } } },
      { $sort: { count: -1 } },
      { $limit: limit },
    ]);

  const [
    liveVisitors,
    uniqueVisitors,
    sessionStats,
    pagesResult,
    pageTitles,
    referrersResult,
    channelsResult,
    countriesResult,
    regionsResult,
    citiesResult,
    browsersResult,
    osResult,
    devicesResult,
    languagesResult,
    screensResult,
    utmSourcesResult,
    utmMediumsResult,
    utmCampaignsResult,
    eventsResult,
    graphDataRaw,
    heatmapResult,
    entryExitResult,
  ] = await Promise.all([
    WebEvent.distinct('visitorId', liveMatch),
    WebEvent.distinct('visitorId', pv),

    WebEvent.aggregate([
      { $match: pv },
      { $group: { _id: '$sessionId', pageViews: { $sum: 1 }, duration: { $sum: '$duration' } } },
      {
        $group: {
          _id: null,
          totalSessions: { $sum: 1 },
          bounces: { $sum: { $cond: [{ $eq: ['$pageViews', 1] }, 1, 0] } },
          totalDuration: { $sum: '$duration' },
          totalPageViews: { $sum: '$pageViews' },
        },
      },
      {
        $project: {
          totalSessions: 1,
          bounceRate: { $cond: [{ $eq: ['$totalSessions', 0] }, 0, { $multiply: [{ $divide: ['$bounces', '$totalSessions'] }, 100] }] },
          avgDuration: { $cond: [{ $eq: ['$totalSessions', 0] }, 0, { $divide: ['$totalDuration', '$totalSessions'] }] },
          totalPageViews: 1,
        },
      },
    ]),

    dim(pv, 'path'),
    dim({ ...pv, title: { $exists: true, $ne: null } }, 'title'),
    dim(pv, 'referrer'),
    dim(pv, 'channel'),
    dim(pv, 'country'),
    dim(pv, 'region'),
    dim(pv, 'city'),
    dim(pv, 'browser', 5),
    dim(pv, 'os', 5),
    dim(pv, 'device', 5),
    dim(pv, 'language'),
    dim(pv, 'screen'),
    dim(pv, 'utm.source'),
    dim(pv, 'utm.medium'),
    dim(pv, 'utm.campaign'),
    dim(ev, 'eventName'),

    WebEvent.aggregate([
      { $match: pv },
      {
        $group: {
          _id: { $dateToString: { format: bucketFormat, date: '$createdAt' } },
          views: { $sum: 1 },
          visitors: { $addToSet: '$visitorId' },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { time: '$_id', views: 1, visitors: { $size: '$visitors' } } },
    ]),

    WebEvent.aggregate([
      { $match: pv },
      { $group: { _id: { day: { $dayOfWeek: '$createdAt' }, hour: { $hour: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { '_id.day': 1, '_id.hour': 1 } },
    ]),

    WebEvent.aggregate([
      { $match: pv },
      { $sort: { createdAt: 1 } },
      { $group: { _id: '$sessionId', entry: { $first: '$path' }, exit: { $last: '$path' } } },
      {
        $facet: {
          entry: [{ $group: { _id: '$entry', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }],
          exit: [{ $group: { _id: '$exit', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }],
        },
      },
    ]),
  ]);

  const graphData = fillTimeGaps(graphDataRaw, resolved, WEB_GRAPH_DEFAULTS, 'time');

  // Busy days / hours, formatted exactly like the unfiltered path.
  const busyDaysMap = new Map<number, number>();
  const busyHoursMap = new Map<number, number>();
  heatmapResult.forEach((h: any) => {
    busyDaysMap.set(h._id.day, (busyDaysMap.get(h._id.day) || 0) + h.count);
    busyHoursMap.set(h._id.hour, (busyHoursMap.get(h._id.hour) || 0) + h.count);
  });
  const busyDays = Array.from({ length: 7 }, (_, i) => ({ name: DAY_LABELS[i + 1], count: busyDaysMap.get(i + 1) || 0 }));
  const busyHours = Array.from({ length: 24 }, (_, i) => ({ name: `${i}:00`, count: busyHoursMap.get(i) || 0 }));

  const stats = sessionStats[0] || { totalPageViews: 0, bounceRate: 0, avgDuration: 0 };
  const totalEvents = (eventsResult || []).reduce((sum: number, e: any) => sum + (e.count || 0), 0);

  return {
    liveVisitors: liveVisitors.length,
    overview: {
      totalViews: stats.totalPageViews,
      uniqueVisitors: uniqueVisitors.length,
      avgDuration: stats.avgDuration,
      bounceRate: stats.bounceRate,
      totalEvents,
    },
    pages: { path: pagesResult, title: pageTitles },
    sources: { referrers: referrersResult, channels: channelsResult },
    geo: { countries: countriesResult, regions: regionsResult, cities: citiesResult },
    system: { devices: devicesResult, browsers: browsersResult, os: osResult, languages: languagesResult, screens: screensResult },
    graph: graphData,
    traffic: { days: busyDays, hours: busyHours },
    events: eventsResult || [],
    campaigns: { sources: utmSourcesResult, mediums: utmMediumsResult, campaigns: utmCampaignsResult },
    entryExit: { entry: entryExitResult[0]?.entry || [], exit: entryExitResult[0]?.exit || [] },
  };
}
