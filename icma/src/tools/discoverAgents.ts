/**
 * src/tools/discoverAgents.ts
 *
 * Discover agents by loading a local registry (agents.json) and optionally
 * probing each agent's /capabilities endpoint to validate and refresh data.
 *
 * Exports: async function discover_agents(opts?: DiscoverOptions): Promise<AgentInfo[]>
 *
 * Notes:
 * - If environment variable EDENLAYER_URL is provided, it will attempt to fetch
 *   an external registry from that URL first (falling back to local agents.json).
 * - Returns a normalized AgentInfo[] array.
 */

import fs from "fs";
import path from "path";
import axios from "axios";

export type AgentInfo = {
  id: string;
  name?: string;
  endpoint: string;
  capabilities: string[];
  meta?: Record<string, any>;
};

export type DiscoverOptions = {
  probeEndpoints?: boolean; // true = call /capabilities on each endpoint
  timeoutMs?: number;
  edenlayerUrl?: string; // optional external registry endpoint
};

const DEFAULT_OPTS: DiscoverOptions = {
  probeEndpoints: true,
  timeoutMs: 3000,
};

function readLocalRegistry(): AgentInfo[] {
  const filePath = path.resolve(process.cwd(), "agents.json");
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((a: any) => ({
      id: String(a.id),
      name: a.name || a.id,
      endpoint: String(a.endpoint),
      capabilities: Array.isArray(a.capabilities) ? a.capabilities : [],
      meta: a.meta || {},
    }));
  } catch (err) {
    console.error("discoverAgents: invalid agents.json:", err);
    return [];
  }
}

async function probeCapabilities(endpoint: string, timeoutMs: number) {
  // endpoint like http://localhost:9001 -> probe /capabilities
  try {
    const url = endpoint.replace(/\/$/, "") + "/capabilities";
    const res = await axios.get(url, { timeout: timeoutMs });
    if (res && res.data) return res.data;
  } catch (err) {
    // swallow errors, return undefined
  }
  return undefined;
}

/**
 * Discover agents
 */
export async function discover_agents(opts?: DiscoverOptions): Promise<AgentInfo[]> {
  const options = { ...DEFAULT_OPTS, ...(opts || {}) };

  // 1) If edenlayerUrl provided, try to fetch
  if (options.edenlayerUrl) {
    try {
      const res = await axios.get(options.edenlayerUrl, { timeout: options.timeoutMs });
      if (Array.isArray(res.data) && res.data.length > 0) {
        // normalize
        return res.data.map((a: any) => ({
          id: String(a.id),
          name: a.name || a.id,
          endpoint: String(a.endpoint),
          capabilities: Array.isArray(a.capabilities) ? a.capabilities : [],
          meta: a.meta || {},
        }));
      }
    } catch (err) {
      console.warn("discover_agents: edenlayer fetch failed, falling back to local registry.");
    }
  }

  // 2) Load local registry
  const registry = readLocalRegistry();

  if (!options.probeEndpoints) return registry;

  // 3) Probe endpoints to refresh capability lists (best-effort)
  const results: AgentInfo[] = [];
  await Promise.all(
    registry.map(async (agent) => {
      const probed = await probeCapabilities(agent.endpoint, options.timeoutMs || 3000);
      if (probed && probed.capabilities && Array.isArray(probed.capabilities)) {
        results.push({
          id: agent.id,
          name: probed.name || agent.name,
          endpoint: agent.endpoint,
          capabilities: probed.capabilities,
          meta: { ...agent.meta, ...(probed.meta || {}) },
        });
      } else {
        // keep registry entry if probing failed
        results.push(agent);
      }
    })
  );

  // remove duplicates (by id) and return
  const uniq: Record<string, AgentInfo> = {};
  for (const a of results) uniq[a.id] = a;
  return Object.values(uniq);
}
