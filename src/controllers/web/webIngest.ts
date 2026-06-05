import { Request, Response } from "express";
import { UAParser } from "ua-parser-js";
import mongoose from "mongoose";
import { WebEvent, WebMetric, Website } from "../../models/Web";
import { logger } from "../../utils/logger";
import { getClientIp } from "../../utils/getClientIp";
import { getGeoData } from "../../utils/getGeoData";
import { getChannel } from "../../utils/categorizeReferrers";
import { WebIngestSchema } from "../../utils/validation";
import { webIngestQueue, enqueue, type WebIngestPayload } from '../../lib/queue';

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
      url,
      path,
      title,
      referrer,
      width,
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
      eventData: { webId, visitorId, sessionId, type, url, path, title, referrer, width, duration },
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
// Background Web Processor (called by queue worker or in-process fallback)
// ---------------------------------------------------------------------------
export const processWebIngestion = async (job: WebIngestPayload): Promise<void> => {
  const { eventData, clientIp, userAgent } = job;
  const { webId, visitorId, sessionId, type, url, path, title, referrer, width, duration } = eventData;

  const { country, city } = getGeoData(clientIp);

  const parser = new UAParser(userAgent);
  const browser = parser.getBrowser().name || "Unknown";
  const os = parser.getOS().name || "Unknown";
  let device: string = parser.getDevice().type || "Desktop";
  if (device === "Desktop" && width && width < 768) device = "Mobile";

  const channelInfo = getChannel(referrer, url);
  const channel = channelInfo.channel;
  const timestamp = new Date();

  if (type === "ping") {
    await WebEvent.findOneAndUpdate(
      { sessionId, path, type: "pageview" },
      { $inc: { duration: duration || 0 } },
      { sort: { createdAt: -1 } }
    );

    const bucketTime = new Date(timestamp);
    bucketTime.setSeconds(0, 0);

    await WebMetric.updateOne(
      { webId, timestamp: bucketTime },
      { $inc: { durationSum: duration || 0 } },
      { upsert: true }
    );
    return;
  }

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
    duration: 0,
    browser,
    os,
    device,
    country,
    city,
    createdAt: timestamp,
  });

  const bucketTime = new Date(timestamp);
  bucketTime.setSeconds(0, 0);

  const pipeline: any[] = [
    {
      $set: {
        views: { $add: [{ $ifNull: ["$views", 0] }, 1] }
      }
    }
  ];

  const addMapToPipeline = (prefix: string, key: string) => {
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

  addMapToPipeline("paths", path);
  addMapToPipeline("referrers", referrer || "Direct");
  addMapToPipeline("channels", channel);
  addMapToPipeline("countries", country);
  addMapToPipeline("cities", city);
  addMapToPipeline("browsers", browser);
  addMapToPipeline("os", os);
  addMapToPipeline("devices", device);

  await WebMetric.updateOne(
    { webId, timestamp: bucketTime },
    pipeline,
    { upsert: true }
  );
};
