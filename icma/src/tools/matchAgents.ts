/**
 * src/tools/matchAgents.ts
 *
 * Build a workflow plan from a user goal and a list of discovered agents.
 * This file includes:
 * - capability ranking
 * - simple heuristic planner
 * - optional LLM hook placeholder (so you can call your LLM provider to refine the plan)
 *
 * Exports: async function match_agents({ goal, agents, useLLM })
 *
 * Returned plan shape:
 * {
 *   goal: string,
 *   workflow: Array<{ stepId: number, role: string, agent: AgentInfo, confidence: number }>,
 *   metadata: { reasons: string[] }
 * }
 */

import type { AgentInfo } from "./discoverAgents";

export type MatchInput = {
  goal: string;
  agents: AgentInfo[];
  useLLM?: boolean; // optional: if true, you can integrate an LLM call to refine plan
};

export async function match_agents({ goal, agents, useLLM = false }: MatchInput) {
  const lower = (goal || "").toLowerCase();

  // Simple, deterministic heuristics -> map common keywords -> roles/capabilities required
  const requirements: { role: string; capabilityKeywords: string[] }[] = [];

  if (lower.includes("wallet") || lower.includes("balance") || lower.includes("transaction")) {
    requirements.push({ role: "data_extractor", capabilityKeywords: ["wallet_scan", "balance_data", "tx_history"] });
  }
  if (lower.includes("report") || lower.includes("generate report") || lower.includes("pdf")) {
    requirements.push({ role: "report_generator", capabilityKeywords: ["generate_report", "process_data", "pdf_export"] });
  }
  if (lower.includes("ipfs") || lower.includes("publish") || lower.includes("upload")) {
    requirements.push({ role: "uploader", capabilityKeywords: ["ipfs_upload", "storage_upload"] });
  }

  // fallback: if nothing matched, try to pick the most capable agent (highest number of capabilities)
  if (requirements.length === 0) {
    // choose top 2 agents by capability count
    const sorted = [...agents].sort((a, b) => b.capabilities.length - a.capabilities.length);
    const workflow = sorted.slice(0, 2).map((agent, i) => ({
      stepId: i + 1,
      role: i === 0 ? "primary" : "secondary",
      agent,
      confidence: 0.6 + (0.2 * (1 - i * 0.5)), // basic confidence
    }));
    return { goal, workflow, metadata: { reasons: ["fallback: highest-capability agents"] } };
  }

  // For each requirement, find the best agent that has any matching capability
  const workflow: { stepId: number; role: string; agent: AgentInfo; confidence: number }[] = [];
  const chosenAgentIds = new Set<string>();
  let stepId = 1;
  const reasons: string[] = [];

  for (const req of requirements) {
    // score each agent: +1 for each capability match
    const scored = agents.map((agent) => {
      const score = agent.capabilities.reduce((acc, cap) => {
        for (const kw of req.capabilityKeywords) {
          if (cap.includes(kw)) return acc + 1;
        }
        return acc;
      }, 0);
      return { agent, score };
    });

    // choose highest score not already chosen
    const sorted = scored.sort((a, b) => b.score - a.score);
    const best = sorted.find((s) => s.score > 0 && !chosenAgentIds.has(s.agent.id));

    if (best) {
      chosenAgentIds.add(best.agent.id);
      workflow.push({
        stepId: stepId++,
        role: req.role,
        agent: best.agent,
        confidence: Math.min(0.95, 0.5 + best.score * 0.15),
      });
      reasons.push(`Requirement ${req.role} satisfied by ${best.agent.id} (score=${best.score})`);
    } else {
      // no agent found for this requirement; pick the best available even if score 0
      const bestAny = sorted.find((s) => !chosenAgentIds.has(s.agent.id));
      if (bestAny) {
        chosenAgentIds.add(bestAny.agent.id);
        workflow.push({
          stepId: stepId++,
          role: req.role,
          agent: bestAny.agent,
          confidence: 0.35,
        });
        reasons.push(`Requirement ${req.role} assigned to ${bestAny.agent.id} (fallback)`);
      } else {
        reasons.push(`No agents available for role ${req.role}`);
      }
    }
  }

  // Optional: LLM refinement hook (not implemented here; provide a place for you to call your LLM)
  if (useLLM) {
    // If you want to refine plan with an LLM, do it here.
    // Example: call your OpenAI / Anthropic wrapper with the goal + workflow and ask to optimize ordering and terms.
    // const refined = await callLLMToRefinePlan(goal, workflow);
    // workflow = refined.workflow;
  }

  return {
    goal,
    workflow,
    metadata: { reasons },
  };
}
