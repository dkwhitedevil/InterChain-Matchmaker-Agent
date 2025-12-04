/**
 * src/tools/negotiateAgents.ts
 *
 * Negotiates with a list of agents by calling POST /negotiate.
 * Returns an array of negotiation results with details.
 *
 * Behavior:
 *  - Sends a minimal proposal {} by default (can be extended)
 *  - Honors timeout and retry per-agent
 *  - Returns object map agentId => { accepted: boolean, rawResponse?, error? }
 */

import type { AgentInfo } from "./discoverAgents";

export type NegotiateResult = {
  agentId: string;
  accepted: boolean;
  statusCode?: number;
  responseBody?: any;
  error?: string;
};

export type NegotiateOptions = {
  timeoutMs?: number;
  retryAttempts?: number;
};

const DEFAULT_OPTS: Required<NegotiateOptions> = {
  timeoutMs: 4000,
  retryAttempts: 1,
};

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

export async function negotiateAgents(agents: AgentInfo[], opts?: NegotiateOptions): Promise<NegotiateResult[]> {
  const options = { ...DEFAULT_OPTS, ...(opts || {}) };

  const out: NegotiateResult[] = [];

  for (const agent of agents) {
    const negotiateUrl = agent.url.replace(/\/+$/, "") + "/negotiate";
    let accepted = false;
    let lastError: string | undefined;
    let respBody: any = undefined;
    let statusCode: number | undefined = undefined;

    for (let attempt = 0; attempt <= options.retryAttempts; attempt++) {
      try {
        const res = await fetchWithTimeout(
          negotiateUrl,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}) // minimal proposal
          },
          options.timeoutMs
        );
        statusCode = res.status;
        const jsonBody: any = await res.json().catch(() => null);
        respBody = jsonBody;
        const ok = (jsonBody && (jsonBody.status === "ACCEPT" || jsonBody.status === "OK" || jsonBody.accepted === true)) || res.status === 200;
        accepted = Boolean(ok);
        if (accepted) break;
        lastError = `unexpected-negotiation-response`;
      } catch (err: any) {
        lastError = (err && err.message) || String(err);
        // small backoff before retry
        if (attempt < options.retryAttempts) {
          await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
        }
      }
    }

    out.push({
      agentId: agent.id,
      accepted,
      statusCode,
      responseBody: respBody,
      error: accepted ? undefined : lastError,
    });
  }

  return out;
}
