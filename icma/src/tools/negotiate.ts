/**
 * src/tools/negotiate.ts
 *
 * Send structured proposals to each agent in the workflow and collect responses.
 * - Retries with exponential backoff for transient errors
 * - Timeouts configurable
 * - Validates responses
 *
 * Export: async function negotiate_terms({ workflow, proposalTemplate, timeoutMs, maxRetries })
 */

import axios from "axios";
import type { AgentInfo } from "./discoverAgents";

export type NegotiateInput = {
  workflow: { stepId: number; role: string; agent: AgentInfo }[];
  proposalTemplate?: { price?: string; deadline?: string; details?: string };
  timeoutMs?: number;
  maxRetries?: number;
};

export type NegotiationResult = {
  status: "OK" | "FAILED" | "PARTIAL";
  responses: Array<{
    agentId: string;
    status: string;
    message?: string;
    raw?: any;
  }>;
};

const DEFAULTS = { timeoutMs: 4000, maxRetries: 2 };

async function postWithRetry(url: string, body: any, timeoutMs: number, maxRetries: number) {
  let attempt = 0;
  let lastError: any = null;
  while (attempt <= maxRetries) {
    try {
      const res = await axios.post(url, body, { timeout: timeoutMs });
      return res.data;
    } catch (err: any) {
      lastError = err;
      attempt++;
      // small exponential backoff
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
  throw lastError;
}

export async function negotiate_terms(input: NegotiateInput): Promise<NegotiationResult> {
  const { workflow, proposalTemplate = {}, timeoutMs = DEFAULTS.timeoutMs, maxRetries = DEFAULTS.maxRetries } = input;
  const responses: NegotiationResult["responses"] = [];

  for (const step of workflow) {
    const agentEndpoint = step.agent.endpoint.replace(/\/$/, "");
    const url = `${agentEndpoint}/negotiate`;

    const proposal = {
      proposalId: `icma-${Date.now()}-${step.stepId}`,
      role: step.role,
      agentId: step.agent.id,
      terms: {
        price: proposalTemplate.price || "0.0001 ETH",
        deadline: proposalTemplate.deadline || "24h",
        details: proposalTemplate.details || `Perform role ${step.role} for goal`,
      },
    };

    try {
      const raw = await postWithRetry(url, { proposal }, timeoutMs, maxRetries);
      // validate raw response shape minimally
      const status = raw && raw.status ? String(raw.status) : "UNKNOWN";
      const message = raw && raw.message ? String(raw.message) : undefined;
      responses.push({ agentId: step.agent.id, status, message, raw });
    } catch (err: any) {
      console.error(`negotiate_terms: failed to contact ${step.agent.id} @ ${url}`, err?.message || err);
      responses.push({ agentId: step.agent.id, status: "ERROR", message: String(err?.message || err), raw: null });
    }
  }

  const okCount = responses.filter((r) => r.status && r.status.toUpperCase() === "ACCEPT").length;
  const failedCount = responses.filter((r) => r.status && (r.status.toUpperCase() === "ERROR" || r.status.toUpperCase() === "REJECT")).length;

  const overall: NegotiationResult = {
    status: okCount === responses.length ? "OK" : okCount > 0 ? "PARTIAL" : "FAILED",
    responses,
  };

  return overall;
}
