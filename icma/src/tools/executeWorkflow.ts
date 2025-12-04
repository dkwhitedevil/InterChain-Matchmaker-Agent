/**
 * src/tools/executeWorkflow.ts
 *
 * Execute each step in the workflow by calling the agent's /execute endpoint.
 * - Supports sequential execution (safe) and parallel option (faster)
 * - Validates outputs (expecting { status: "DONE", output: {...} })
 * - Collects logs, durations, errors
 *
 * Export: async function execute_workflow({ workflow, parallel = false, timeoutMs })
 */

import axios from "axios";
import type { AgentInfo } from "./discoverAgents";

export type ExecuteInput = {
  workflow: { stepId: number; role: string; agent: AgentInfo }[];
  parallel?: boolean;
  timeoutMs?: number;
};

export type ExecuteResult = {
  status: "OK" | "FAILED" | "PARTIAL";
  outputs: Array<{
    agentId: string;
    stepId: number;
    status: string;
    output?: any;
    durationMs?: number;
    error?: string;
  }>;
};

const DEFAULT_TIMEOUT = 8000;

async function callExecute(endpoint: string, body: any, timeoutMs: number) {
  const start = Date.now();
  const res = await axios.post(endpoint, body, { timeout: timeoutMs });
  const duration = Date.now() - start;
  return { data: res.data, durationMs: duration };
}

export async function execute_workflow(input: ExecuteInput): Promise<ExecuteResult> {
  const { workflow, parallel = false, timeoutMs = DEFAULT_TIMEOUT } = input;
  const outputs: ExecuteResult["outputs"] = [];

  if (parallel) {
    // execute all steps concurrently
    await Promise.all(
      workflow.map(async (step) => {
        const url = `${step.agent.endpoint.replace(/\/$/, "")}/execute`;
        try {
          const { data, durationMs } = await callExecute(url, { task: step.role }, timeoutMs);
          const status = data?.status || "UNKNOWN";
          outputs.push({ agentId: step.agent.id, stepId: step.stepId, status, output: data?.output, durationMs });
        } catch (err: any) {
          outputs.push({ agentId: step.agent.id, stepId: step.stepId, status: "ERROR", error: String(err?.message || err) });
        }
      })
    );
  } else {
    // execute sequentially (recommended for workflows with dependencies)
    for (const step of workflow) {
      const url = `${step.agent.endpoint.replace(/\/$/, "")}/execute`;
      try {
        const { data, durationMs } = await callExecute(url, { task: step.role }, timeoutMs);
        const status = data?.status || "UNKNOWN";
        outputs.push({ agentId: step.agent.id, stepId: step.stepId, status, output: data?.output, durationMs });
      } catch (err: any) {
        outputs.push({ agentId: step.agent.id, stepId: step.stepId, status: "ERROR", error: String(err?.message || err) });
        // if a critical step fails, break early to avoid useless calls
        // decide policy: here we break if step failed
        break;
      }
    }
  }

  const successCount = outputs.filter((o) => o.status && o.status.toUpperCase() === "DONE").length;
  const failedCount = outputs.filter((o) => o.status && (o.status.toUpperCase() === "ERROR" || o.status.toUpperCase() === "FAILED")).length;

  const overallStatus: ExecuteResult["status"] = successCount === outputs.length ? "OK" : successCount > 0 ? "PARTIAL" : "FAILED";

  return { status: overallStatus, outputs };
}
