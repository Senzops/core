import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { GetPromptRequestSchema, ListPromptsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// ============================================================================
// MCP Prompts — investigation runbooks
// ----------------------------------------------------------------------------
// User-invoked, parameterized workflows (surfaced as slash-commands in the
// host). Each prompt packages Senzor's observability domain knowledge into a
// step-by-step plan that orchestrates the existing read tools, so an agent runs
// a best-practice investigation instead of improvising. Prompts return guidance
// text only — they never touch the database; the agent executes the tools.
// ============================================================================

interface PromptArg {
  name: string;
  description: string;
  required?: boolean;
}

interface PromptDef {
  name: string;
  description: string;
  arguments: PromptArg[];
  build: (args: Record<string, string>) => string;
}

const PROMPTS: PromptDef[] = [
  {
    name: "investigate_incident",
    description: "Run a full root-cause investigation on a specific alert incident, correlating the triggering signal with traces, logs and errors.",
    arguments: [
      { name: "incidentId", description: "The incident _id (from alerts_list_incidents).", required: true },
    ],
    build: ({ incidentId }) => `You are an SRE investigating Senzor incident "${incidentId}". Work methodically and cite the data you used.

1. Call \`alerts_get_incident_detail\` with id="${incidentId}" to get the triggering condition, severity, affected entity, policy and timeline.
2. Identify the affected service/monitor and the incident time window from the timeline.
3. Pull the relevant signal for that window:
   - Backend service → \`apm_get_stats\` then \`apm_get_invocations\`; open the slowest/failing trace with \`apm_get_trace_detail\`.
   - Frontend app → \`rum_get_dashboard\` then \`rum_get_trace_detail\`.
   - Uptime monitor → \`uptime_get_stats\`. Infra → \`vps_get_stats\`. Queue → \`queue_get_stats\`/\`queue_get_executions\`.
4. Correlate failures: \`error_get_global\` and \`error_get_group_detail\` for new/spiking error groups; \`logs_query\` with level:error around the window, and \`logs_get_by_trace\`/\`error_get_trace_errors\` for any suspect traceId.
5. Conclude with: probable root cause, supporting evidence (ids/metrics), blast radius, and concrete remediation + prevention steps. State explicitly if the data is inconclusive.`,
  },
  {
    name: "rca_service",
    description: "Diagnose the health of a single APM (backend) service over a time range and explain any latency, error-rate or runtime regressions.",
    arguments: [
      { name: "serviceId", description: "The APM service id (from apm_list_services).", required: true },
      { name: "range", description: "Time range, e.g. 1h / 24h / 7d. Defaults to 24h.", required: false },
    ],
    build: ({ serviceId, range }) => `Diagnose the health of APM service "${serviceId}" over range "${range || "24h"}".

1. \`apm_get_stats\` (id="${serviceId}", range="${range || "24h"}") — review latency (p50/p95/p99), RPS and error rate; note any regression vs the rest of the window.
2. \`apm_get_runtime_stats\` — check event-loop lag/utilization, GC frequency/duration, heap and CPU for saturation or leaks.
3. \`apm_get_invocations\` — find the slowest and error endpoints; open the worst with \`apm_get_trace_detail\` to locate the dominant span (DB/HTTP/compute).
4. \`error_get_global\` + \`error_get_group_detail\` for this service's error groups; \`logs_query\` (level:error) for corroborating log lines.
5. Summarize: top bottleneck, whether it is code/dependency/resource bound, supporting evidence, and prioritized fixes.`,
  },
  {
    name: "triage_error_group",
    description: "Triage a specific error group: assess impact, find a representative trace, and recommend a fix.",
    arguments: [
      { name: "groupId", description: "The error group/fingerprint id (from error_get_global).", required: true },
      { name: "range", description: "Time range, e.g. 24h / 7d. Defaults to 24h.", required: false },
    ],
    build: ({ groupId, range }) => `Triage error group "${groupId}" over range "${range || "24h"}".

1. \`error_get_group_detail\` (groupId="${groupId}", range="${range || "24h"}") — read the exception type/message, stack, frequency trend, first/last seen and affected releases.
2. Assess impact: occurrence count, trend (growing/stable/declining), and how many users/services are affected.
3. Pick a representative occurrence with a traceId; use \`apm_get_trace_detail\` (or \`rum_get_trace_detail\`) and \`logs_get_by_trace\` to reconstruct exactly what happened.
4. Conclude with: severity, likely cause from the stack/trace, suggested fix, and whether it warrants an alert policy.`,
  },
  {
    name: "ai_cost_review",
    description: "Review LLM spend for an AI Monitoring source: where the money goes, who is driving it, and how to reduce it.",
    arguments: [
      { name: "sourceId", description: "The AI Monitoring source id (from ai_list_sources).", required: true },
      { name: "range", description: "Time range, e.g. 24h / 7d / 30d. Defaults to 7d.", required: false },
    ],
    build: ({ sourceId, range }) => `Perform a cost-optimization review of AI source "${sourceId}" over range "${range || "7d"}".

1. \`ai_get_stats\` (id="${sourceId}", range="${range || "7d"}") — total cost (USD), call/token volume, error rate, latency percentiles, and breakdowns by model/provider/operation. Identify the costliest models and operations.
2. \`ai_get_consumers\` — attribute spend to top users and sessions; flag outliers.
3. \`ai_get_traces\` (status="error") then \`ai_get_trace_detail\` on a few — quantify wasted spend from failed/retried generations.
4. Recommend: model right-sizing, prompt/context reduction, caching, and error-rate fixes — each with the estimated $ impact based on the data.`,
  },
  {
    name: "reliability_report",
    description: "Produce a reliability summary across uptime, incidents and errors for a time range — suitable for a weekly review.",
    arguments: [
      { name: "range", description: "Time range, e.g. 7d / 30d. Defaults to 7d.", required: false },
    ],
    build: ({ range }) => `Produce a platform reliability report for the last "${range || "7d"}".

1. \`uptime_list_monitors\` then \`uptime_get_stats\` per monitor — report uptime % and any downtime windows.
2. \`alerts_list_incidents\` (status="all") — count by severity and status; highlight criticals and still-open incidents; note MTTA/MTTR if derivable from timelines.
3. \`error_get_global\` — top unresolved error groups and their trend.
4. Spot-check key services with \`apm_list_services\` + \`apm_get_stats\` for latency/error-rate regressions.
5. Deliver an executive summary: overall health, notable incidents, trending risks, and the top 3 recommended actions for next week.`,
  },
];

export const registerSenzorPrompts = (server: Server) => {
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map(({ name, description, arguments: args }) => ({ name, description, arguments: args })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const prompt = PROMPTS.find((p) => p.name === name);
    if (!prompt) throw new Error(`Prompt not found: ${name}`);

    for (const arg of prompt.arguments) {
      if (arg.required && !args?.[arg.name]) {
        throw new Error(`Missing required argument: "${arg.name}"`);
      }
    }

    return {
      description: prompt.description,
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: prompt.build((args as Record<string, string>) || {}) },
        },
      ],
    };
  });
};
