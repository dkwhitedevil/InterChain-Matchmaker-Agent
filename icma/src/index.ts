/**
 * ICMA Orchestrator Cloudflare Worker (MODULE WORKER VERSION)
 *
 * Exposes:
 *  - GET  /capabilities
 *  - GET  /test-wallet
 *  - GET  /test-report
 *  - POST /negotiate
 *  - POST /execute
 */

import { discoverAgents } from "./tools/discoverAgents";
import { matchCapabilities, MatchResult } from "./tools/matchCapabilities";
import { negotiateAgents } from "./tools/negotiateAgents";
import { executeWorkflow } from "./tools/executeWorkflow";

// PROXY to bypass Cloudflare Worker→Worker fetch restrictions
const PROXY = "https://api.allorigins.win/raw?url=";
const WALLET_AGENT = PROXY + encodeURIComponent("https://wallet-agent.icma.workers.dev");
const REPORT_AGENT = PROXY + encodeURIComponent("https://report-agent-worker.icma.workers.dev");

export interface Env {}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function error(message: string, code = 400): Response {
  return json({ status: "ERROR", message }, code);
}

/** Minimal Ethereum address validator */
function isEthAddress(str: string): boolean {
  return typeof str === "string" && /^0x[a-fA-F0-9]{40}$/.test(str);
}

/** Our workflow steps */
const WORKFLOW_STEPS = ["wallet_scan", "generate_report"];

/* -------------------------
   MODULE WORKER ENTRYPOINT
   ------------------------- */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env);
  }
};

/* -------------------------
   MAIN REQUEST HANDLER
   ------------------------- */
async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  /* ---------- CAPABILITIES ---------- */
  if (path === "/capabilities") {
    return json({
      id: "icma-orchestrator",
      name: "ICMA Orchestrator",
      capabilities: ["orchestrate_workflow", "discover_agents"]
    });
  }

  /* ---------- TEST WALLET AGENT ---------- */
  if (path === "/test-wallet") {
    try {
      const res = await fetch(`${WALLET_AGENT}/capabilities`, {
        method: "GET",
      });

      const text = await res.text();
      return new Response(text, { status: res.status });
    } catch (e: any) {
      return new Response(`ERROR: ${e.message}`, { status: 500 });
    }
  }

  /* ---------- TEST REPORT AGENT ---------- */
  if (path === "/test-report") {
    try {
      const res = await fetch(`${REPORT_AGENT}/capabilities`, {
        method: "GET",
      });

      const text = await res.text();
      return new Response(text, { status: res.status });
    } catch (e: any) {
      return new Response(`ERROR: ${e.message}`, { status: 500 });
    }
  }

  /* ---------- NEGOTIATE ---------- */
  if (path === "/negotiate") {
    return json({
      status: "ACCEPT",
      message: "ICMA orchestrator accepts proposals."
    });
  }

  /* ---------- EXECUTE WORKFLOW ---------- */
  if (path === "/execute" && request.method === "POST") {
    // Parse body
    let body: any;
    try {
      body = await request.json();
    } catch {
      return error("Invalid JSON body");
    }

    const address = body?.address || body?.wallet;
    if (!address || !isEthAddress(address)) {
      return error("Missing or invalid Ethereum address");
    }

    // 1. Discover agents
    const registryUrl = new URL("/agents.json", url.origin).toString();

    const agents = await discoverAgents({
      registryUrl,
      probeEndpoints: true,
      timeoutMs: 4000
    });

    if (!agents.length) return error("No agents discovered", 500);

    // 2. Match capabilities
    const matches = matchCapabilities(agents, WORKFLOW_STEPS);

    const missing = WORKFLOW_STEPS.filter(step => !matches.some(m => m.step === step));
    if (missing.length > 0) {
      return error(`Missing agents for steps: ${missing.join(", ")}`, 500);
    }

    // 3. Negotiate
    const negotiations = await negotiateAgents(
      matches.map(m => m.agent),
      { timeoutMs: 4000 }
    );

    const refused = negotiations.filter(n => !n.accepted);
    if (refused.length > 0) {
      return error(
        `Negotiation failed for agents: ${refused.map(r => r.agentId).join(", ")}`,
        502
      );
    }

    // 4. Execute workflow
    const exec = await executeWorkflow(
      matches as MatchResult[],
      { address },
      { timeoutMs: 15000, retryAttempts: 1 }
    );

    if (!exec.success) {
      return json(
        {
          status: "ERROR",
          message: exec.error || "Workflow execution failed",
          logs: exec.logs
        },
        502
      );
    }

    // Extract outputs
    const walletOutput = exec.logs.find(l => l.step === "wallet_scan")?.output || null;
    const reportOutput = exec.logs.find(l => l.step === "generate_report")?.output || null;

    return json({
      status: "DONE",
      wallet: walletOutput,
      report: reportOutput,
      logs: exec.logs,
      agents: matches.map(m => ({
        step: m.step,
        id: m.agent.id,
        endpoint: m.agent.endpoint
      })),
      timestamp: Date.now()
    });
  }

  /* ---------- ROOT ---------- */
  if (path === "/") {
    return new Response(
      [
        "ICMA Orchestrator Worker",
        "",
        "GET  /capabilities",
        "GET  /test-wallet",
        "GET  /test-report",
        "POST /negotiate",
        "POST /execute  { address: \"0x...\" }",
        "",
        "Workflow: wallet_scan → generate_report"
      ].join("\n"),
      { headers: { "content-type": "text/plain" } }
    );
  }

  return error("Route not found", 404);
}
