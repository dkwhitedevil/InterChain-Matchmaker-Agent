/**
 * src/orchestrator.ts
 *
 * ICMA Orchestrator Cloudflare Worker
 *
 * Exposes:
 *  - GET  /capabilities
 *  - POST /negotiate     (accept simple proposals)
 *  - POST /execute       (main entry: { address: "0x..." })
 *
 * Behavior:
 *  - Loads agents.json from the same origin (assets/agents.json) by default
 *  - Discovers and probes agents
 *  - Matches capabilities for workflow: wallet_scan -> generate_report
 *  - Negotiates with matched agents
 *  - Executes workflow sequentially, returns final result & execution log
 */

import { discoverAgents, AgentInfo } from "./tools/discoverAgents";
import { matchCapabilities, MatchResult } from "./tools/matchCapabilities";
import { negotiateAgents } from "./tools/negotiateAgents";
import { executeWorkflow } from "./tools/executeWorkflow";

export interface Env {
  // Optional: add keys if orchestrator needs to call protected agents
  // EXAMPLE_API_KEY?: string;
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function error(message: string, code = 400) {
  return json({ status: "ERROR", message }, code);
}

/* Minimal address validator (ETH hex) */
function isProbablyEthAddress(v: any): boolean {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}

/* Workflow steps for ICMA */
const WORKFLOW_STEPS = ["wallet_scan", "generate_report"];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/capabilities" && request.method === "GET") {
      return json({
        id: "icma-orchestrator",
        name: "ICMA Orchestrator",
        capabilities: ["orchestrate_workflow", "discover_agents"],
      });
    }

    if (path === "/negotiate" && request.method === "POST") {
      // minimal negotiation acceptance
      return json({ status: "ACCEPT", message: "ICMA orchestrator accepts proposals." });
    }

    if (path === "/execute" && request.method === "POST") {
      // parse body
      let body: any;
      try {
        body = await request.json();
      } catch {
        return error("Invalid JSON body", 400);
      }

      const address = body?.address || body?.wallet;
      if (!address || !isProbablyEthAddress(address)) {
        return error("Missing or invalid Ethereum address (address or wallet)", 400);
      }

      // 1) Discover agents (try loading assets/agents.json on same origin)
      const registryUrl = new URL("/agents.json", url.origin).toString();
      const agents = await discoverAgents({
        registryUrl,
        probeEndpoints: true,
        timeoutMs: 3000,
        probeConcurrency: 4,
        retryAttempts: 1,
      });

      // 2) Match capabilities
      const matches = matchCapabilities(agents, WORKFLOW_STEPS);

      // detect missing steps
      const missing = WORKFLOW_STEPS.filter(step => !matches.some(m => m.step === step));
      if (missing.length > 0) {
        return error(`Missing agents for steps: ${missing.join(", ")}`, 500);
      }

      // 3) Negotiate with selected agents
      const negotiateResults = await negotiateAgents(matches.map(m => m.agent), { timeoutMs: 4000, retryAttempts: 1 });
      const refused = negotiateResults.filter(r => !r.accepted);
      if (refused.length > 0) {
        return error(`Negotiation failed for agents: ${refused.map(r => r.agentId).join(", ")}`, 502);
      }

      // 4) Execute workflow
      // initial payload: pass address under { address } (agents expect either address or wallet)
      const initialPayload = { address };
      const execResult = await executeWorkflow(matches as MatchResult[], initialPayload, { timeoutMs: 12000, retryAttempts: 1 });

      if (!execResult.success) {
        return json({
          status: "ERROR",
          message: execResult.error || "Execution failed",
          logs: execResult.logs || [],
        }, 502);
      }

      // 5) Final response
      return json({
        status: "DONE",
        wallet: execResult.finalOutput, // walletOutput from wallet-agent (or final agent's output if pipeline changes)
        report: execResult.finalOutput, // Note: ReportAgent output will be in finalOutput if pipeline uses that mapping; to be explicit, one can examine logs
        logs: execResult.logs,
        agents: matches.map(m => ({ step: m.step, id: m.agent.id, url: m.agent.url })),
        timestamp: Date.now(),
      }, 200);
    }

    // Health / simple help
    if (path === "/" && request.method === "GET") {
      return new Response(
        [
          "ICMA Orchestrator Worker",
          "",
          "GET  /capabilities",
          "POST /negotiate",
          "POST /execute   { \"address\": \"0x...\" }",
          "",
          "This worker orchestrates wallet_scan -> generate_report using discovered agents.",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/plain" } }
      );
    }

    return error("Route not found", 404);
  },
};
