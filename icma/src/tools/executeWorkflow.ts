/**
 * src/tools/executeWorkflow.ts
 *
 * Execute matched agents sequentially. The `matches` are an array of { step, agent } in desired order.
 *
 * Behavior:
 *  - Calls each agent's /execute with current payload
 *  - Validates that the agent returns { status: "DONE", output: ... }
 *  - Pipes the `output` as next step's payload (or use mapping)
 *  - Supports per-agent timeouts and retries
 *  - Returns the final output and a step-by-step execution log
 */

import type { AgentInfo } from "./discoverAgents";
import type { MatchResult } from "./matchCapabilities";

export type ExecutionLogEntry = {
  step: string;
  agentId: string;
  success: boolean;
  statusCode?: number;
  durationMs?: number;
  error?: string;
  output?: any;
};

export type ExecuteOptions = {
  timeoutMs?: number;
  retryAttempts?: number;
};

const DEFAULT_OPTS: Required<ExecuteOptions> = {
  timeoutMs: 12000,
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

export async function executeWorkflow(matches: MatchResult[], initialPayload: any, opts?: ExecuteOptions) {
  const options = { ...DEFAULT_OPTS, ...(opts || {}) };
  const logs: ExecutionLogEntry[] = [];
  let payload = initialPayload;

  for (const m of matches) {
    const execUrl = m.agent.url.replace(/\/+$/, "") + "/execute";
    let success = false;
    let lastError = "";
    let out: any = undefined;
    let statusCode: number | undefined = undefined;
    const start = Date.now();

    for (let attempt = 0; attempt <= options.retryAttempts; attempt++) {
      try {
        const res = await fetchWithTimeout(execUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }, options.timeoutMs);

        statusCode = res.status;
        const jsonBody: any = await res.json().catch(() => null);

        if (jsonBody && jsonBody.status === "DONE") {
          success = true;
          out = jsonBody.output ?? jsonBody;
          break;
        } else {
          lastError = `unexpected-response`;
          out = jsonBody;
        }
      } catch (err: any) {
        lastError = (err && err.message) || String(err);
        // backoff between retries
        if (attempt < options.retryAttempts) await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
      }
    }

    const durationMs = Date.now() - start;
    logs.push({
      step: m.step,
      agentId: m.agent.id,
      success,
      statusCode,
      durationMs,
      error: success ? undefined : lastError,
      output: out,
    });

    if (!success) {
      // abort workflow if any step fails
      return { success: false, error: `Agent ${m.agent.id} failed at step ${m.step}`, logs, lastOutput: out };
    }

    // next payload - default: put under 'walletData' or pass entire output
    payload = out;
  }

  return { success: true, finalOutput: payload, logs };
}
