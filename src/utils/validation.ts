import { z } from 'zod';

export const RegisterVpsSchema = z.object({
  name: z.string().min(1).max(50),
});

// Integration Sub-Schemas

const NginxStatsSchema = z.object({
  activeConnections: z.number(),
  accepts: z.number(),
  handled: z.number(),
  requests: z.number(),
  reading: z.number(),
  writing: z.number(),
  waiting: z.number(),
  reqPerSec: z.number(),
}).nullable().optional();

const TraefikComponentSchema = z.object({
  total: z.number(),
  active: z.number(),
  failed: z.number(),
});

const TraefikStatsSchema = z.object({
  routers: TraefikComponentSchema,
  services: TraefikComponentSchema,
  middlewares: TraefikComponentSchema,
}).nullable().optional();


// Matches the Agent's TelemetryPayload interface
export const TelemetrySchema = z.object({
  os: z.object({
    platform: z.string(),
    distro: z.string(),
    hostname: z.string(),
  }).passthrough(), // Allow extra OS fields
  cpu: z.object({
    usagePercent: z.number(),
    cores: z.number(),
  }).passthrough(),
  memory: z.object({
    total: z.number(),
    used: z.number(),
    usagePercent: z.number(),
  }).passthrough(),
  disk: z.object({
    total: z.number(),
    used: z.number(),
    usagePercent: z.number(),
  }).passthrough(),
  network: z.object({
    bytesRecvSec: z.number(),
    bytesSentSec: z.number(),
    latencyMs: z.number().optional(),
  }),
  processes: z.object({
    total: z.number(),
    running: z.number(),
    blocked: z.number(),
    sleeping: z.number(),
  }).optional(),
  docker: z.array(z.object({
    name: z.string(),
    state: z.string(),
    cpuPercent: z.number().optional(),
    memoryUsage: z.number().optional(),
  }).passthrough()).optional().default([]),


  // Integrations
  nginx: NginxStatsSchema,
  traefik: TraefikStatsSchema,

  uptimeSeconds: z.number(),
  timestamp: z.string(),
});

//  Web Analytics Schemas 
export const RegisterWebsiteSchema = z.object({
  name: z.string().min(1).max(50),
  domain: z.string().min(3).max(253).regex(
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/,
    "Invalid domain or subdomain format"
  )
});

export const WebStatsQuerySchema = z.object({
  range: z.enum(['24h', '7d', '30d']).default('24h'),
});

// --- Uptime Schemas ---
export const RegisterMonitorSchema = z.object({
  name: z.string().min(1).max(50),
  url: z.string().url(),
  interval: z.enum(['15', '30', '60']).transform(Number), // accept strings, convert to number
});
