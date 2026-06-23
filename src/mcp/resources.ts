import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { simulateExpressCall, trackUsage } from "./registry";

import { getDynamicSchema } from "../controllers/schema";
import { getDashboardCapabilities } from "../controllers/dashboard/capabilities";
import { getApmStats } from "../controllers/apm/stats";
import { getIncidentDetail } from "../controllers/alerts";

// ============================================================================
// MCP Resources — app-controlled context
// ----------------------------------------------------------------------------
// Addressable, read-only context the host can attach without a tool round-trip.
// Backed by the SAME controllers as the equivalent tools (no duplicated logic) —
// resources are a convenience layer over the data, while tools remain the
// workhorse for agents. Two kinds:
//   * Static   — fixed URIs (schema, capabilities)
//   * Templated — parameterized URIs (per-entity catalogs)
// All reads are owner-scoped via the authenticated ownerId and metered like tools.
// ============================================================================

const MIME = "application/json";

interface StaticResource {
  uri: string;
  name: string;
  description: string;
  controller: Function;
  track: string;
}

const STATIC_RESOURCES: StaticResource[] = [
  {
    uri: "senzor://schema",
    name: "Telemetry Schema",
    description: "Dynamically inferred field map for all telemetry data types. Use it to build precise MongoDB aggregation pipelines for custom widgets.",
    controller: getDynamicSchema,
    track: "resource:schema",
  },
  {
    uri: "senzor://capabilities",
    name: "Platform Capabilities",
    description: "The account's data-retention limits per service type and the valid time-range options — needed to construct valid range queries.",
    controller: getDashboardCapabilities,
    track: "resource:capabilities",
  },
];

interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description: string;
  pattern: RegExp;
  // Build the (controller, params, query) call from the captured URI groups.
  resolve: (groups: string[]) => { controller: Function; params: Record<string, any>; query: Record<string, any> };
  track: string;
}

const RESOURCE_TEMPLATES: ResourceTemplate[] = [
  {
    uriTemplate: "senzor://apm/{serviceId}/stats",
    name: "APM Service Stats",
    description: "Performance aggregations (latency, RPS, error rate) for an APM service over the last 24h.",
    pattern: /^senzor:\/\/apm\/([^/]+)\/stats$/,
    resolve: ([serviceId]) => ({ controller: getApmStats, params: { id: decodeURIComponent(serviceId) }, query: { range: "24h" } }),
    track: "resource:apm_stats",
  },
  {
    uriTemplate: "senzor://incidents/{incidentId}",
    name: "Incident Detail",
    description: "Full detail of a single alert incident: triggering condition, policy, severity, timeline and metadata.",
    pattern: /^senzor:\/\/incidents\/([^/]+)$/,
    resolve: ([incidentId]) => ({ controller: getIncidentDetail, params: { id: decodeURIComponent(incidentId) }, query: {} }),
    track: "resource:incident",
  },
];

export const registerSenzorResources = (server: Server, ownerId: string) => {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: STATIC_RESOURCES.map(({ uri, name, description }) => ({ uri, name, description, mimeType: MIME })),
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: RESOURCE_TEMPLATES.map(({ uriTemplate, name, description }) => ({
      uriTemplate,
      name,
      description,
      mimeType: MIME,
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    const resolved = resolveUri(uri);
    if (!resolved) throw new Error(`Resource not found: ${uri}`);

    trackUsage(ownerId, resolved.track);
    const result = await simulateExpressCall(resolved.controller, ownerId, resolved.params, resolved.query);

    if (result.status >= 400) {
      throw new Error(`Resource read failed (${result.status}): ${JSON.stringify(result.data)}`);
    }

    return {
      contents: [{ uri, mimeType: MIME, text: JSON.stringify(result.data, null, 2) }],
    };
  });
};

const resolveUri = (uri: string):
  | { controller: Function; params: Record<string, any>; query: Record<string, any>; track: string }
  | null => {
  const staticRes = STATIC_RESOURCES.find((r) => r.uri === uri);
  if (staticRes) return { controller: staticRes.controller, params: {}, query: {}, track: staticRes.track };

  for (const tmpl of RESOURCE_TEMPLATES) {
    const match = uri.match(tmpl.pattern);
    if (match) return { ...tmpl.resolve(match.slice(1)), track: tmpl.track };
  }
  return null;
};
