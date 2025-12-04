/**
 * src/tools/matchCapabilities.ts
 *
 * Match a workflow (list of required capability names) to agents discovered.
 *
 * Exports:
 *  - type MatchResult
 *  - function matchCapabilities(agents, steps, options)
 *
 * Features:
 *  - Supports multiple candidate agents per capability
 *  - Chooses first-fit or simple scoring based on presence of capability
 *  - Returns array of selected agent per step
 */

import type { AgentInfo } from "./discoverAgents";

export type MatchResult = {
  step: string;
  agent: AgentInfo;
};

export type MatchOptions = {
  preferAgentIds?: string[]; // prefer these agent ids in order
};

export function matchCapabilities(agents: AgentInfo[], steps: string[], opts?: MatchOptions): MatchResult[] {
  const options = opts || {};
  const results: MatchResult[] = [];

  for (const step of steps) {
    // prefer agents listed in preferAgentIds that support the step
    let candidate: AgentInfo | undefined;
    if (options.preferAgentIds) {
      for (const pref of options.preferAgentIds) {
        const a = agents.find(x => x.id === pref && x.capabilities.includes(step));
        if (a) {
          candidate = a;
          break;
        }
      }
    }

    // otherwise pick first agent that advertises capability
    if (!candidate) {
      candidate = agents.find((a) => Array.isArray(a.capabilities) && a.capabilities.includes(step));
    }

    if (candidate) {
      results.push({ step, agent: candidate });
    }
  }

  return results;
}
