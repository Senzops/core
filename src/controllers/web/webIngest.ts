import { Request, Response } from "express";
import geoip from "geoip-lite";
import { UAParser } from "ua-parser-js";
import { WebEvent, WebMetric, Website } from "../../models/Web";
import { logger } from "../../utils/logger";
import {
  EMAIL_HOST_HINTS,
  PAID_MEDIUM_HINTS,
  SEARCH_HOSTS,
  SOCIAL_HOSTS,
} from "../../utils/categorizeReferrers";

// Helper to determine traffic channel
const getChannel = (referrer: string, url: string) => {
  if (!referrer || referrer === "Direct") return "Direct";
  const ref = referrer.toLowerCase();

  if (url) {
    const r = new URL(url);
    const params = r.searchParams;
    const utmMedium = params.get("utm_medium");
    if (utmMedium) {
      const mediumLower = utmMedium.toLowerCase();
      if (PAID_MEDIUM_HINTS.some((h) => mediumLower.includes(h))) return "Paid";
      if (mediumLower.includes("email")) return "Email";
      if (mediumLower.includes("social")) return "Social";
    }
  }

  if (SEARCH_HOSTS.some((h) => ref.includes(h))) return "Search";
  if (SOCIAL_HOSTS.some((h) => ref.includes(h))) return "Social";
  if (EMAIL_HOST_HINTS.some((h) => ref.includes(h))) return "Email";

  return "Referral";
};

export const ingestWebMetrics = async (req: Request, res: Response) => {
  try {
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
    } = req.body;

    // Check if Website exists in DB
    const site = await Website.findOne({ _id: webId });
    if (!site) return res.status(404).json({ error: "Website not found" });

    // 1. Respond Immediately (Fire-and-forget)
    // We send 200 OK right away so the user's browser isn't waiting
    res.status(200).send("ok");

    // 2. Background Processing
    setImmediate(async () => {
      try {
        // --- A. Enrichment ---
        let ip =
          req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
        if (Array.isArray(ip)) ip = ip[0];
        if (typeof ip === "string" && ip.includes("::ffff:"))
          ip = ip.replace("::ffff:", "");
        const geo = geoip.lookup(ip as string);
        const country = geo?.country || "Unknown";
        const city = geo?.city || "Unknown";

        const uaString = req.headers["user-agent"] || "";
        const parser = new UAParser(uaString);
        const browser = parser.getBrowser().name || "Unknown";
        const os = parser.getOS().name || "Unknown";
        let device = parser.getDevice().type || "Desktop";
        if (device === "Desktop" && width && width < 768) device = "Mobile";

        const channel = getChannel(referrer, url);
        const timestamp = new Date();

        // --- B. Handle Ping (Duration Update) ---
        if (type === "ping") {
          // Update Raw Trace
          await WebEvent.findOneAndUpdate(
            { sessionId, path, type: "pageview" },
            { $inc: { duration: duration || 0 } },
            { sort: { createdAt: -1 } },
          );

          // Update Metric (Add duration to the bucket)
          const bucketTime = new Date(timestamp);
          bucketTime.setSeconds(0, 0);

          await WebMetric.updateOne(
            { webId, timestamp: bucketTime },
            { $inc: { durationSum: duration || 0 } },
            { upsert: true },
          );
          return;
        }

        // --- C. Store Pageview (Raw) ---
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

        // --- D. Update Metric (Aggregated) ---
        const bucketTime = new Date(timestamp);
        bucketTime.setSeconds(0, 0);

        const incUpdate: any = { views: 1 };
        const addMap = (prefix: string, key: string) => {
          const safeKey = key.replace(/\./g, "_").replace(/\$/g, "");
          incUpdate[`${prefix}.${safeKey}`] = 1;
        };

        addMap("paths", path);
        addMap("referrers", referrer || "Direct");
        addMap("channels", channel);
        addMap("countries", country);
        addMap("cities", city);
        addMap("browsers", browser);
        addMap("os", os);
        addMap("devices", device);

        await WebMetric.updateOne(
          { webId, timestamp: bucketTime },
          { $inc: incUpdate },
          { upsert: true },
        );
      } catch (bgError) {
        logger.error("Background Web Ingest Error", bgError);
      }
    });
  } catch (error) {
    logger.error("Senzor Web Ingest Error", error);
    // Already sent response, but log it
  }
};
