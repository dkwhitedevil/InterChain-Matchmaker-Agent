/**
 * ICMA Orchestrator - Cloudflare Worker (TypeScript)
 *
 * Responsibilities:
 *  - Load agent registry (URL from env: AGENT_REGISTRY_URL)
 *  - Probe agents for /capabilities
 *  - Match workflow steps -> agent (simple capability match)
 *  - Send /negotiate (if available) to confirm participation
 *  - Execute steps via /execute
 *  - Retry with backoff on transient failures
 *  - Return combined output with logs, agentsUsed, and error handling
 *
 * Usage:
 *  - POST /orchestrate with JSON body:
 *    {
 *      "workflow": [
 *        { "step": "analyze_wallet", "capability": "wallet_scan", "input": {"address":"0x..."} },
 *        { "step": "generate_report", "capability": "generate_report" }
 *      ]
 *    }
 *
 *  - If workflow omitted, default: wallet_scan -> generate_report
 */

type AgentDescriptor = {
  id?: string;
  name?: string;
  endpoint: string; // base url for agent (e.g. https://wallet-agent.icma.workers.dev)
  meta?: Record<string, any>;
};

type ProbeCapabilitiesResponse = {
  capabilities: string[]; // e.g. ["wallet_scan"]
  info?: Record<string, any>;
};

type AgentProbe = AgentDescriptor & {
  capabilities: string[];
};

type WorkflowStep = {
  step: string;
  capability: string;
  input?: any;
  // optional: agentOverride: string (an agent endpoint) to force an agent
};

type OrchestratorResult = {
  status: "DONE" | "FAILED";
  wallet?: any;
  report?: any;
  agentsUsed: string[];
  logs: string[];
  error?: string;
  raw?: any;
};

const DEFAULT_REGISTRY =
  "https://raw.githubusercontent.com/dkwhitedevil/InterChain-Matchmaker-Agent/main/agents.json"; // fallback

// Configurable from environment
export default {
  async fetch(request: Request, env: any, ctx: any) {
    const logs: string[] = [];
    const agentsUsed: string[] = [];

    function log(msg: string) {
      logs.push(`${new Date().toISOString()} - ${msg}`);
      // keep logs limited
      if (logs.length > 200) logs.shift();
    }

    try {
      if (request.method.toUpperCase() !== "POST") {
        return new Response(
          JSON.stringify({
            ok: true,
            message: "ICMA Orchestrator. POST a JSON workflow to /orchestrate",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      // Type-safe JSON parsing
      let body: Record<string, any> = {};
      try {
        body = (await request.json()) as Record<string, any>;
      } catch (_) {
        body = {};
      }

      const registryUrl = env.AGENT_REGISTRY_URL || DEFAULT_REGISTRY;

      log(`Loading agent registry from ${registryUrl}`);
      const registry = await loadAgentRegistry(registryUrl, log);

      log(`Probing ${registry.length} agents for capabilities`);
      const probed = await probeAgents(registry, log);

      // Build capability map: capability -> agents[]
      const capabilityMap = new Map<string, AgentProbe[]>();
      for (const p of probed) {
        for (const c of p.capabilities) {
          const arr = capabilityMap.get(c) || [];
          arr.push(p);
          capabilityMap.set(c, arr);
        }
      }

      // Determine workflow
      let workflow: WorkflowStep[] = [];
      if (Array.isArray(body.workflow) && body.workflow.length > 0) {
        workflow = body.workflow;
      } else {
        // default workflow matching your project: wallet_scan -> generate_report
        workflow = [
          { step: "analyze_wallet", capability: "wallet_scan", input: body.input || body },
          { step: "generate_report", capability: "generate_report" },
        ];
      }

      log(`Workflow determined with ${workflow.length} steps`);

      const finalOutput: any = {};
      for (const step of workflow) {
        log(`Processing step: ${step.step} (capability: ${step.capability})`);

        // find agent
        const candidates = capabilityMap.get(step.capability) || [];
        if (candidates.length === 0) {
          const err = `No agent found with capability "${step.capability}"`;
          log(err);
          return respondError(err, logs);
        }

        // choose best candidate (simple: first one, prefer same-origin if env hint)
        const chosen = chooseAgent(candidates, env, log);
        log(`Chosen agent ${chosen.name || chosen.endpoint} for capability ${step.capability}`);
        agentsUsed.push(chosen.name || chosen.endpoint);

        // optional negotiation
        try {
          const negotiated = await negotiateAgent(
            chosen,
            { step: step.step, capability: step.capability },
            log
          );
          if (!negotiated) {
            const err = `Agent ${chosen.endpoint} rejected negotiation for capability ${step.capability}`;
            log(err);
            return respondError(err, logs);
          }
        } catch (e) {
          // negotiation failure treated as fatal for now
          const err = `Negotiation error with ${chosen.endpoint}: ${String(e)}`;
          log(err);
          return respondError(err, logs);
        }

        // Execute with retries
        const executeInput = step.input ?? finalOutput; // pass previous outputs by default
        log(
          `Executing agent ${chosen.endpoint} /execute with input ${truncateForLog(
            JSON.stringify(executeInput)
          )}`
        );
        const execResponse = await executeAgentWithRetries(chosen.endpoint, executeInput, log);

        if (!execResponse || execResponse.status !== "DONE") {
          const err = `Agent execution failed for ${chosen.endpoint} (step ${step.step})`;
          log(`${err} - response: ${truncateForLog(JSON.stringify(execResponse))}`);
          return respondError(err, logs);
        }

        // incorporate outputs in finalOutput depending on capability
        // custom mapping: wallet_scan -> finalOutput.wallet , generate_report -> finalOutput.report
        switch (step.capability) {
          case "wallet_scan":
            finalOutput.wallet = execResponse.output || execResponse;
            break;
          case "generate_report":
            finalOutput.report = execResponse.output || execResponse;
            break;
          default:
            // generic: append to finalOutput.rawSteps
            finalOutput.rawSteps = finalOutput.rawSteps || [];
            finalOutput.rawSteps.push({
              step: step.step,
              capability: step.capability,
              output: execResponse.output || execResponse,
            });
        }

        log(`Step ${step.step} completed by ${chosen.endpoint}`);
      }

      const result: OrchestratorResult = {
        status: "DONE",
        ...finalOutput,
        agentsUsed,
        logs,
      };

      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (err: any) {
      log(`Unexpected orchestrator error: ${String(err)}`);
      return respondError(String(err), logs);
    }
  },
};

/* ---------- Helper functions ---------- */

async function loadAgentRegistry(
  registryUrl: string,
  log: (s: string) => void
): Promise<AgentDescriptor[]> {
  try {
    const res = await fetchWithTimeout(registryUrl, { method: "GET" }, 6000);
    if (!res.ok) {
      log(`Registry fetch error: ${res.status} ${res.statusText}`);
      return [];
    }
    const data = await res.json();
    // registry expected to be array of objects with endpoint field
    if (Array.isArray(data)) {
      return data.map((x: any) => ({
        id: x.id,
        name: x.name,
        endpoint: x.endpoint || x.url || x.baseUrl,
        meta: x,
      }));
    }
    return [];
  } catch (e) {
    log(`Failed to load registry: ${String(e)}`);
    return [];
  }
}

async function probeAgents(registry: AgentDescriptor[], log: (s: string) => void): Promise<AgentProbe[]> {
  const probes: AgentProbe[] = [];
  const probePromises = registry.map(async (agent) => {
    try {
      const url = joinTrim(agent.endpoint, "/capabilities");
      const res = await fetchWithTimeout(url, { method: "GET", headers: { accept: "application/json" } }, 4000);
      if (!res.ok) {
        log(`Probe failed for ${agent.endpoint} -> HTTP ${res.status}`);
        return;
      }
      // IMPORTANT: read the response from `res`, not `request`
      const body = (await res.json().catch(() => ({}))) as Record<string, any>;
      const caps: string[] = Array.isArray(body.capabilities) ? body.capabilities : (body?.capabilities ?? []);
      probes.push({ ...agent, capabilities: caps });
      log(`Probed ${agent.endpoint}: ${caps.join(", ")}`);
    } catch (e) {
      log(`Probe error for ${agent.endpoint}: ${String(e)}`);
    }
  });

  await Promise.all(probePromises);
  return probes;
}

function chooseAgent(candidates: AgentProbe[], env: any, log: (s: string) => void): AgentProbe {
  // Prioritize by name containing "Worker" then first in list.
  // Later: implement scoring
  candidates.sort((a, b) => {
    const aScore = scoreAgent(a, env);
    const bScore = scoreAgent(b, env);
    return bScore - aScore;
  });
  const chosen = candidates[0];
  log(`Agent scoring picks ${chosen.name || chosen.endpoint}`);
  return chosen;
}

function scoreAgent(a: AgentProbe, env: any): number {
  let score = 0;
  if ((a.name || "").toLowerCase().includes("worker")) score += 10;
  if ((a.endpoint || "").startsWith("https://")) score += 2;
  // prefer agents in same project domain if env has ORCHESTRATOR_DOMAIN
  if (env && env.ORCHESTRATOR_DOMAIN && a.endpoint.includes(env.ORCHESTRATOR_DOMAIN)) score += 5;
  return score;
}

async function negotiateAgent(
  agent: AgentProbe,
  proposal: { step: string; capability: string },
  log: (s: string) => void
): Promise<boolean> {
  // If agent exposes /negotiate POST, call with { proposal }
  const negotiateUrl = joinTrim(agent.endpoint, "/negotiate");
  try {
    const res = await fetchWithTimeout(
      negotiateUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposal }),
      },
      5000
    );
    if (!res.ok) {
      log(`Negotiate HTTP ${res.status} for ${negotiateUrl}. Treating as acceptance if 404/405?`);
      // if 404 or 405 (no negotiate implemented), treat as acceptance
      if (res.status === 404 || res.status === 405) return true;
      return false;
    }
    // IMPORTANT: read the agent's response body from `res`
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (typeof body.accept === "boolean") {
      return body.accept;
    }
    // older agents may respond with status field
    if (body.status === "ACCEPT" || body.status === "OK" || body.status === "accepted") return true;
    return true; // default to true
  } catch (e) {
    // If network error or timeout, fallback to true only if it's safe to proceed
    log(`Negotiate error for ${agent.endpoint}: ${String(e)} - defaulting to true`);
    return true;
  }
}

async function executeAgentWithRetries(agentBase: string, input: any, log: (s: string) => void) {
  const endpoint = joinTrim(agentBase, "/execute");
  const maxAttempts = 3;
  let attempt = 0;
  const baseDelay = 300; // ms

  while (attempt < maxAttempts) {
    attempt++;
    try {
      const res = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        15000
      ); // 15s timeout for execution
      const text = await res.text();
      if (!res.ok) {
        log(`Execute attempt ${attempt} for ${endpoint} failed HTTP ${res.status} - body: ${truncateForLog(text)}`);
        // Retry on 5xx only
        if (res.status >= 500 && attempt < maxAttempts) {
          await delay(baseDelay * Math.pow(2, attempt));
          continue;
        }
        // for client errors, do not retry
        return { status: "FAILED", httpStatus: res.status, body: text };
      }
      // parse JSON
      try {
        const data = JSON.parse(text);
        return data;
      } catch (e) {
        log(`Execute JSON parse error for ${endpoint}: ${String(e)} - returning raw text`);
        return { status: "DONE", output: text };
      }
    } catch (e: any) {
      log(`Execute attempt ${attempt} network error: ${String(e)}`);
      if (attempt < maxAttempts) {
        await delay(baseDelay * Math.pow(2, attempt));
        continue;
      }
      return { status: "FAILED", error: String(e) };
    }
  }
  return { status: "FAILED", error: "Max attempts reached" };
}

/* ----------------- Utilities ------------------ */

function respondError(err: string, logs: string[]) {
  const result: OrchestratorResult = {
    status: "FAILED",
    agentsUsed: [],
    logs,
    error: err,
  };
  return new Response(JSON.stringify(result, null, 2), { status: 500, headers: { "content-type": "application/json" } });
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeout = 8000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    // attach signal
    const response = await fetch(url, { ...init, signal: controller.signal } as any);
    clearTimeout(id);
    return response;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

function joinTrim(base: string, path: string) {
  if (!base) return path;
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

function delay(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

function truncateForLog(s: string, max = 800) {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max) + `...[${s.length - max} chars truncated]`;
}
