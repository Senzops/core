import { z } from 'zod';

export const RegisterVpsSchema = z.object({
  name: z.string().min(1).max(50),
});

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
  }),
  docker: z.array(z.object({
    name: z.string(),
    state: z.string(),
    cpuPercent: z.number(),
    memoryUsage: z.number(),
  })).optional().default([]),
  uptimeSeconds: z.number(),
  timestamp: z.string(),
});