import { Request, Response } from "express";
import { UAParser } from "ua-parser-js";
import mongoose from "mongoose";
import { WebEvent, WebEventData, WebMetric, Website, type IWebEventData } from "../../models/Web";
import { logger } from "../../utils/logger";
import { getClientIp } from "../../utils/getClientIp";
import { getGeoData } from "../../utils/getGeoData";
import { getChannel } from "../../utils/categorizeReferrers";
import { parseUtm } from "../../utils/parseUtm";
import { WebIngestSchema } from "../../utils/validation";
import { webIngestQueue, enqueue, type WebIngestPayload } from '../../lib/queue';
import { getRetentionMs } from '../../services/retentionCache';

// ---------------------------------------------------------------------------
// Bot detection — skip known crawlers to keep analytics clean
// ---------------------------------------------------------------------------

const isBot = (uaString: string): boolean => {
  if (!uaString) return false;
  const parser = new UAParser(uaString);
  const browserName = (parser.getBrowser().name || "").toLowerCase();
  if (browserName.includes("bot") || browserName.includes("crawler") || browserName.includes("spider")) return true;

  const botPatterns =
    /bot|crawl|spider|slurp|mediapartners|headless|phantom|puppeteer|playwright|lighthouse|pagespeed|gtmetrix|pingdom|uptimerobot|semrush|ahrefs|mj12bot|dotbot|baiduspider|yandexbot|sogou|exabot|facebot|ia_archiver|archive\.org/i;
  return botPatterns.test(uaString);
};

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export const ingestWebMetrics = async (req: Request, res: Response) => {
  try {
    // --- Validate request body ---
    const parsed = WebIngestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten().fieldErrors });
    }

    const {
      webId,
      visitorId,
      sessionId,
      type,
      eventName,
      props,
      url,
      path,
      title,
      referrer,
      width,
      height,
      language,
      duration,
    } = parsed.data;

    // --- Validate webId is a valid ObjectId ---
    if (!mongoose.Types.ObjectId.isValid(webId)) {
      return res.status(400).json({ error: "Invalid webId format" });
    }

    // --- Skip bots ---
    const uaString = req.headers["user-agent"] || "";
    if (isBot(uaString as string)) {
      return res.status(200).send("ok");
    }

    // Validate website exists before acknowledging the request
    const site = await Website.findOne({ _id: webId });
    if (!site) return res.status(404).json({ error: "Website not found" });

    // Respond immediately — browser doesn't wait for geo/DB work
    res.status(200).send("ok");

    // -------------------------------------------------------------------------
    // Background processing (via Queue)
    // -------------------------------------------------------------------------
    const clientIp = getClientIp(req) || 'Unknown';
    const jobData: WebIngestPayload = {
      eventData: { webId, visitorId, sessionId, type, eventName, props, url, path, title, referrer, width, height, language, duration },
      ownerId: site.ownerId,
      clientIp,
      userAgent: uaString as string,
    };

    await enqueue<WebIngestPayload>(
      webIngestQueue,
      jobData,
      () => { processWebIngestion(jobData).catch(err => logger.error("Background Web Ingest Error", err)); },
    );
  } catch (error) {
    logger.error("Senzor Web Ingest Error", error);
  }
};

// ---------------------------------------------------------------------------
// Metric map-increment helper
// ---------------------------------------------------------------------------
// Pushes an aggregation-pipeline stage that increments WebMetric.<prefix>.<key>
// by 1. `$setField` is used (rather than a dotted `$inc`) so high-cardinality,
// arbitrary keys (paths, UTM values, event names) — which may contain dots — are
// stored as literal map fields without violating MongoDB field-name rules.
const pushMapInc = (pipeline: any[], prefix: string, key: string) => {
  const safeKey = key.replace(/\$/g, "");

  pipeline.push({
    $set: {
      [prefix]: {
        $setField: {
          field: safeKey,
          input: { $ifNull: [`$${prefix}`, {}] },
          value: {
            $add: [
              { $ifNull: [{ $getField: { field: safeKey, input: `$${prefix}` } }, 0] },
              1
            ]
          }
        }
      }
    }
  });
};

// Builds one typed WebEventData document per custom-event property.
const buildEventDataDocs = (
  webId: string,
  eventId: any,
  eventName: string,
  props: Record<string, string | number | boolean | null>,
  timestamp: Date,
  retentionMs: number
): Partial<IWebEventData>[] => {
  const docs: Partial<IWebEventData>[] = [];
  const expiresAt = new Date(timestamp.getTime() + retentionMs);

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue;

    const base = { webId: webId as any, eventId, eventName, key, createdAt: timestamp, expiresAt };

    if (typeof value === "number" && Number.isFinite(value)) {
      docs.push({ ...base, dataType: "number", numberValue: value });
    } else if (typeof value === "boolean") {
      docs.push({ ...base, dataType: "boolean", boolValue: value });
    } else if (typeof value === "string") {
      docs.push({ ...base, dataType: "string", stringValue: value.slice(0, 512) });
    }
  }

  return docs;
};

// ---------------------------------------------------------------------------
// Background Web Processor (called by queue worker or in-process fallback)
// ---------------------------------------------------------------------------
export const processWebIngestion = async (job: WebIngestPayload): Promise<void> => {
  const { eventData, ownerId, clientIp, userAgent } = job;
  const { webId, visitorId, sessionId, type, eventName, props, url, path, title, referrer, width, height, language, duration } = eventData;

  // Resolve the owner's plan-based retention window once for this event.
  const retentionMs = await getRetentionMs(ownerId);

  const { country, region, city } = getGeoData(clientIp);

  const parser = new UAParser(userAgent);
  const browser = parser.getBrowser().name || "Unknown";
  const os = parser.getOS().name || "Unknown";
  let device: string = parser.getDevice().type || "Desktop";
  if (device === "Desktop" && width && width < 768) device = "Mobile";

  const lang = (language || "Unknown").slice(0, 35);
  const screen = width && height ? `${width}x${height}` : "Unknown";

  const channelInfo = getChannel(referrer, url);
  const channel = channelInfo.channel;
  const timestamp = new Date();

  const bucketTime = new Date(timestamp);
  bucketTime.setSeconds(0, 0);

  if (type === "ping") {
    await WebEvent.findOneAndUpdate(
      { sessionId, path, type: "pageview" },
      { $inc: { duration: duration || 0 } },
      { sort: { createdAt: -1 } }
    );

    await WebMetric.updateOne(
      { webId, timestamp: bucketTime },
      {
        $inc: { durationSum: duration || 0 },
        $set: { expiresAt: new Date(bucketTime.getTime() + retentionMs) },
      },
      { upsert: true }
    );
    return;
  }

  const utm = parseUtm(url);

  // -------------------------------------------------------------------------
  // Custom event — counted independently of pageviews. Does NOT touch `views`
  // or the pageview dimension maps so view-based metrics stay clean.
  // -------------------------------------------------------------------------
  if (type === "event") {
    if (!eventName) return; // defensive — validation guarantees this

    const eventDoc = await WebEvent.create({
      webId,
      visitorId,
      sessionId,
      type: "event",
      eventName,
      url,
      path,
      title: title || "Unknown",
      referrer: referrer || "Direct",
      channel,
      utm: utm || undefined,
      duration: 0,
      browser,
      os,
      device,
      country,
      region,
      city,
      language: lang,
      screen,
      createdAt: timestamp,
      expiresAt: new Date(timestamp.getTime() + retentionMs),
    });

    if (props && Object.keys(props).length > 0) {
      const dataDocs = buildEventDataDocs(webId, eventDoc._id, eventName, props, timestamp, retentionMs);
      if (dataDocs.length > 0) {
        await WebEventData.insertMany(dataDocs, { ordered: false }).catch((err) =>
          logger.error("Web Event Data Insert Error", err)
        );
      }
    }

    const pipeline: any[] = [
      { $set: { expiresAt: new Date(bucketTime.getTime() + retentionMs) } }
    ];
    pushMapInc(pipeline, "events", eventName);
    if (utm?.source) pushMapInc(pipeline, "utmSources", utm.source);
    if (utm?.medium) pushMapInc(pipeline, "utmMediums", utm.medium);
    if (utm?.campaign) pushMapInc(pipeline, "utmCampaigns", utm.campaign);

    await WebMetric.updateOne({ webId, timestamp: bucketTime }, pipeline, { upsert: true });
    return;
  }

  // -------------------------------------------------------------------------
  // Pageview
  // -------------------------------------------------------------------------
  await WebEvent.create({
    webId,
    visitorId,
    sessionId,
    type,
    url,
    path,
    title: title || "Unknown",
    referrer: referrer || "Direct",
    channel,
    utm: utm || undefined,
    duration: 0,
    browser,
    os,
    device,
    country,
    region,
    city,
    language: lang,
    screen,
    createdAt: timestamp,
    expiresAt: new Date(timestamp.getTime() + retentionMs),
  });

  const pipeline: any[] = [
    {
      $set: {
        views: { $add: [{ $ifNull: ["$views", 0] }, 1] },
        expiresAt: new Date(bucketTime.getTime() + retentionMs),
      }
    }
  ];

  pushMapInc(pipeline, "paths", path);
  pushMapInc(pipeline, "referrers", referrer || "Direct");
  pushMapInc(pipeline, "channels", channel);
  pushMapInc(pipeline, "countries", country);
  pushMapInc(pipeline, "regions", region);
  pushMapInc(pipeline, "cities", city);
  pushMapInc(pipeline, "browsers", browser);
  pushMapInc(pipeline, "os", os);
  pushMapInc(pipeline, "devices", device);
  pushMapInc(pipeline, "languages", lang);
  pushMapInc(pipeline, "screens", screen);

  // Campaign attribution — only when the landing URL carried UTM params.
  if (utm?.source) pushMapInc(pipeline, "utmSources", utm.source);
  if (utm?.medium) pushMapInc(pipeline, "utmMediums", utm.medium);
  if (utm?.campaign) pushMapInc(pipeline, "utmCampaigns", utm.campaign);

  await WebMetric.updateOne(
    { webId, timestamp: bucketTime },
    pipeline,
    { upsert: true }
  );
};
