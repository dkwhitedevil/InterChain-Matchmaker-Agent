/**
 * ICMA Orchestrator Cloudflare Worker
 */

import { discoverAgents } from "./tools/discoverAgents";
import { matchCapabilities, MatchResult } from "./tools/matchCapabilities";
import { negotiateAgents } from "./tools/negotiateAgents";
import { executeWorkflow } from "./tools/executeWorkflow";

// GitHub raw capability endpoints (SAFE to fetch from Workers)
const WALLET_CAP_URL =
  "https://raw.githubusercontent.com/dkwhitedevil/InterChain-Matchmaker-Agent/main/public/wallet-cap.json";

const REPORT_CAP_URL =
  "https://raw.githubusercontent.com/dkwhitedevil/InterChain-Matchmaker-Agent/main/public/report-cap.json";

export interface Env {}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function error(message: string, code = 400) {
  return json({ status: "ERROR", message }, code);
}

function isEthAddress(str: string): boolean {
  return typeof str === "string" && /^0x[a-fA-F0-9]{40}$/.test(str);
}

const WORKFLOW_STEPS = ["wallet_scan", "generate_report"];

/* MODULE WORKER ENTRY */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env);
  },
};

/* MAIN HANDLER */
async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  /* CAPABILITIES */
  if (path === "/capabilities") {
    return json({
      id: "icma-orchestrator",
      name: "ICMA Orchestrator",
      capabilities: ["orchestrate_workflow", "discover_agents"],
    });
  }

  /* TEST WALLET AGENT */
  if (path === "/test-wallet") {
    try {
      const res = await fetch(WALLET_CAP_URL);
      return new Response(await res.text(), { status: res.status });
    } catch (e: any) {
      return new Response("ERROR: " + e.message, { status: 500 });
    }
  }

  /* TEST REPORT AGENT */
  if (path === "/test-report") {
    try {
      const res = await fetch(REPORT_CAP_URL);
      return new Response(await res.text(), { status: res.status });
    } catch (e: any) {
      return new Response("ERROR: " + e.message, { status: 500 });
    }
  }

  /* NEGOTIATE */
  if (path === "/negotiate") {
    return json({
      status: "ACCEPT",
      message: "ICMA orchestrator accepts proposals.",
    });
  }

  /* EXECUTE WORKFLOW */
  if (path === "/execute" && request.method === "POST") {
    interface ExecuteBody {
    address?: string;
    wallet?: string;
  }

  let body: ExecuteBody = {};
  try {
    body = await request.json() as ExecuteBody;
  } catch {
    return error("Invalid JSON body");
  }

  const address = body.address || body.wallet;
    if (!address || !isEthAddress(address)) {
      return error("Missing or invalid Ethereum address");
    }

    // Discover agents using assets/agents.json 
    const registryUrl = new URL("/agents.json", url.origin).toString();

    const agents = await discoverAgents({
      registryUrl,
      probeEndpoints: true,
      timeoutMs: 4000,
    });

    if (!agents.length) return error("No agents discovered", 500);

    // Match capability → agent
    const matches = matchCapabilities(agents, WORKFLOW_STEPS);

    const missing = WORKFLOW_STEPS.filter(
      (step) => !matches.some((m) => m.step === step)
    );

    if (missing.length > 0) {
      return error("Missing agents for steps: " + missing.join(", "), 500);
    }

    // Negotiate
    const negotiations = await negotiateAgents(matches.map((m) => m.agent), {
      timeoutMs: 4000,
    });

    const refused = negotiations.filter((r) => !r.accepted);
    if (refused.length > 0) {
      return error(
        "Negotiation failed for: " +
          refused.map((r) => r.agentId).join(", "),
        502
      );
    }

    // Execute workflow
    const exec = await executeWorkflow(matches as MatchResult[], { address }, {
      timeoutMs: 15000,
      retryAttempts: 1,
    });

    if (!exec.success) {
      return json({
        status: "ERROR",
        message: exec.error,
        logs: exec.logs,
      }, 502);
    }

    return json({
      status: "DONE",
      wallet: exec.logs.find((x) => x.step === "wallet_scan")?.output,
      report: exec.logs.find((x) => x.step === "generate_report")?.output,
      logs: exec.logs,
      timestamp: Date.now(),
    });
  }

  /* ROOT */
  return new Response(
    [
      "ICMA Orchestrator Worker",
      "",
      "GET  /capabilities",
      "GET  /test-wallet",
      "GET  /test-report",
      "POST /execute",
    ].join("\n"),
    { headers: { "content-type": "text/plain" } }
  );
}
