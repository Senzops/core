import { Request, Response } from "express";
import { UAParser } from "ua-parser-js";
import { WebEvent, WebMetric, Website } from "../../models/Web";
import { logger } from "../../utils/logger";
import { getClientIp } from "../../utils/getClientIp";
import { getGeoData } from "../../utils/getGeoData";
import {
  EMAIL_HOST_HINTS,
  PAID_MEDIUM_HINTS,
  SEARCH_HOSTS,
  SOCIAL_HOSTS,
} from "../../utils/categorizeReferrers";

// ---------------------------------------------------------------------------
// Traffic channel classifier
// ---------------------------------------------------------------------------

const getChannel = (referrer: string, url: string): string => {
  if (!referrer || referrer === "Direct") return "Direct";
  const ref = referrer.toLowerCase();

  if (url) {
    try {
      const r = new URL(url);
      const utmMedium = r.searchParams.get("utm_medium");
      if (utmMedium) {
        const mediumLower = utmMedium.toLowerCase();
        if (PAID_MEDIUM_HINTS.some((h) => mediumLower.includes(h))) return "Paid";
        if (mediumLower.includes("email")) return "Email";
        if (mediumLower.includes("social")) return "Social";
      }
    } catch {
      // Malformed URL — fall through to header-based classification
    }
  }

  if (SEARCH_HOSTS.some((h) => ref.includes(h))) return "Search";
  if (SOCIAL_HOSTS.some((h) => ref.includes(h))) return "Social";
  if (EMAIL_HOST_HINTS.some((h) => ref.includes(h))) return "Email";

  return "Referral";
};

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

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

    // Validate website exists before acknowledging the request
    const site = await Website.findOne({ _id: webId });
    if (!site) return res.status(404).json({ error: "Website not found" });

    // Respond immediately — browser doesn't wait for geo/DB work
    res.status(200).send("ok");

    // -------------------------------------------------------------------------
    // Background processing (fire-and-forget)
    // -------------------------------------------------------------------------
    setImmediate(async () => {
      try {
        // --- A. IP extraction ---
        // getClientIp checks all proxy headers in priority order and
        // returns a clean, normalised IP string (or null).
        const clientIp = getClientIp(req);

        // --- B. Geo lookup ---
        // Tries CDN headers first (free + instant), then local MaxMind DB.
        // Never returns "Unknown" due to a private IP being passed to the DB.
        const { country, city } = await getGeoData(clientIp);

        // --- C. User-agent parsing ---
        const uaString = req.headers["user-agent"] || "";
        const parser = new UAParser(uaString);
        const browser = parser.getBrowser().name || "Unknown";
        const os = parser.getOS().name || "Unknown";
        let device: string = parser.getDevice().type || "Desktop";
        if (device === "Desktop" && width && width < 768) device = "Mobile";

        const channel = getChannel(referrer, url);
        const timestamp = new Date();

        // --- D. Handle ping (duration heartbeat) ---
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

        // --- E. Store raw pageview event ---
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

        // --- F. Update aggregated metric bucket (1-minute resolution) ---
        const bucketTime = new Date(timestamp);
        bucketTime.setSeconds(0, 0);

        const incUpdate: Record<string, number> = { views: 1 };

        const addMap = (prefix: string, key: string) => {
          // Sanitise keys: MongoDB disallows '.' and '$' in field names
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
          { upsert: true }
        );
      } catch (bgError) {
        logger.error("Background Web Ingest Error", bgError);
      }
    });
  } catch (error) {
    logger.error("Senzor Web Ingest Error", error);
  }
};