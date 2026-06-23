import { Request, Response } from 'express';
import { McpUsage } from '../models/Mcp';
import { getRetentionMs } from '../services/retentionCache';

// ============================================================================
// MCP Registry — shared execution primitives
// ----------------------------------------------------------------------------
// Central, transport-agnostic helpers used by tools (and, in later phases,
// resources and prompts): the Express-controller bridge, usage tracking, and
// input-schema validation. Keeping these in one place means every MCP surface
// dispatches, validates, and meters identically.
// ============================================================================

// --- Minimal JSON-Schema shape used by MCP tool/resource definitions ---
export interface JsonSchema {
  type?: string;
  properties?: Record<string, { type?: string; enum?: any[]; default?: any }>;
  required?: string[];
}

// --- 1. Express controller bridge ---------------------------------------------
// Invokes a standard Express controller out-of-band (no real HTTP request) and
// resolves with the status + JSON body it produced. The mock `res` supports the
// response surface our read controllers actually use (status/json/send/end);
// any other Express response method throws a clear, attributable error instead
// of failing with a cryptic "x is not a function" deep in a controller.
export const simulateExpressCall = async (
  controller: Function,
  ownerId: string,
  params: Record<string, any> = {},
  query: Record<string, any> = {}
): Promise<{ status: number; data: any }> => {
  return new Promise((resolve, reject) => {
    const req = {
      ownerId,
      user: { uid: ownerId },
      params,
      query,
      body: {},
      headers: {},
      ip: '127.0.0.1',
    } as unknown as Request;

    let currentStatus = 200; // Closure replaces `this.statusCode`.

    const unsupported = (method: string) => () => {
      reject(new Error(`Controller used unsupported response method res.${method}() in MCP context`));
      return res;
    };

    const res = {
      status: (code: number) => {
        currentStatus = code;
        return res;
      },
      json: (data: any) => {
        resolve({ status: currentStatus, data });
        return res;
      },
      send: (data: any) => {
        resolve({ status: currentStatus, data });
        return res;
      },
      end: () => {
        resolve({ status: currentStatus, data: null });
        return res;
      },
      // Streaming / header / redirect / cookie responses can't be marshalled
      // back to an MCP tool result — fail fast and clearly.
      set: unsupported('set'),
      setHeader: unsupported('setHeader'),
      type: unsupported('type'),
      redirect: unsupported('redirect'),
      cookie: unsupported('cookie'),
      sendFile: unsupported('sendFile'),
      write: unsupported('write'),
      pipe: unsupported('pipe'),
    } as unknown as Response;

    const next = (err?: any) => {
      if (err) reject(err);
      else resolve({ status: 500, data: { error: 'Next() called without error' } });
    };

    try {
      Promise.resolve(controller(req, res, next)).catch(reject);
    } catch (error) {
      reject(error);
    }
  });
};

// --- 2. Usage tracking --------------------------------------------------------
// Fire-and-forget hourly bucket upsert with plan-based expiry (anchor: timestamp).
export const trackUsage = (ownerId: string, toolName: string) => {
  const bucketTime = new Date();
  bucketTime.setMinutes(0, 0, 0);
  getRetentionMs(ownerId)
    .then((retentionMs) =>
      McpUsage.updateOne(
        { ownerId, timestamp: bucketTime },
        {
          $inc: { totalQueries: 1, [`toolCalls.${toolName}`]: 1 },
          $set: { expiresAt: new Date(bucketTime.getTime() + retentionMs) },
        },
        { upsert: true }
      )
    )
    .catch(() => { });
};

// --- 3. Input validation ------------------------------------------------------
// The low-level MCP `Server` does NOT validate arguments against inputSchema, so
// we do it here before dispatch. Lenient and forgiving (extra keys allowed,
// numeric strings coerced to numbers) but strict on the contract that matters:
// required params present, declared types respected, enum membership enforced.
// Returns the (possibly coerced) args, or throws with a clear message.
export const validateToolArgs = (schema: JsonSchema | undefined, rawArgs: any): Record<string, any> => {
  const args: Record<string, any> = rawArgs && typeof rawArgs === 'object' ? { ...rawArgs } : {};
  if (!schema || schema.type !== 'object') return args;

  for (const field of schema.required || []) {
    const v = args[field];
    if (v === undefined || v === null || v === '') {
      throw new Error(`Missing required parameter: "${field}"`);
    }
  }

  const props = schema.properties || {};
  for (const [key, spec] of Object.entries(props)) {
    if (args[key] === undefined || args[key] === null) continue;
    const value = args[key];

    if (spec.type === 'number') {
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isNaN(n)) throw new Error(`Parameter "${key}" must be a number`);
      args[key] = n;
    } else if (spec.type === 'string') {
      if (typeof value !== 'string') throw new Error(`Parameter "${key}" must be a string`);
    }

    if (spec.enum && !spec.enum.includes(args[key])) {
      throw new Error(`Parameter "${key}" must be one of: ${spec.enum.join(', ')}`);
    }
  }

  return args;
};
