/**
 * src/tools/discoverAgents.ts
 *
 * Worker-safe agent discovery & probing utility.
 *
 * Exports:
 *   - types: AgentInfo, DiscoverOptions
 *   - function discoverAgents(opts?: DiscoverOptions): Promise<AgentInfo[]>
 *
 * Notes:
 * - Uses fetch() only (Cloudflare Worker compatible).
 * - Can load a registry via registryUrl (recommended: same origin /agents.json).
 * - Probes /capabilities endpoints with concurrency control and timeouts.
 */

export type AgentInfo = {
  id: string;
  name?: string;
  url: string; // base url of agent
  capabilities: string[];
  meta?: Record<string, any>;
};

export type DiscoverOptions = {
  registryUrl?: string; // ex: "https://example.workers.dev/agents.json" or "/agents.json"
  probeEndpoints?: boolean; // default true
  timeoutMs?: number; // per-request timeout
  probeConcurrency?: number; // default 4
  retryAttempts?: number; // probe retry attempts
};

const DEFAULT_OPTS: Required<DiscoverOptions> = {
  registryUrl: "/agents.json",
  probeEndpoints: true,
  timeoutMs: 3000,
  probeConcurrency: 4,
  retryAttempts: 1,
};

/* Helper: fetch with timeout */
async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(input, { ...(init || {}), signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

/* Load registry JSON from a URL. Returns null on failure */
async function loadRegistry(registryUrl: string, timeoutMs: number): Promise<any[] | null> {
  try {
    const res = await fetchWithTimeout(registryUrl, { method: "GET" }, timeoutMs);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data)) return null;
    return data;
  } catch {
    return null;
  }
}

/* Probe /capabilities for a single agent with retries */
async function probeCapabilities(urlBase: string, timeoutMs: number, retries: number): Promise<any | null> {
  const url = urlBase.replace(/\/+$/, "") + "/capabilities";
  let attempt = 0;
  while (attempt <= retries) {
    try {
      const res = await fetchWithTimeout(url, { method: "GET" }, timeoutMs);
      if (!res.ok) {
        attempt++;
        continue;
      }
      const data = await res.json();
      return data;
    } catch {
      attempt++;
      // small jitter before next attempt
      if (attempt <= retries) await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
    }
  }
  return null;
}

/* concurrency-limited map */
async function pMap<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  async function worker() {
    while (true) {
      const index = currentIndex++;
      if (index >= items.length) break;

      try {
        results[index] = await mapper(items[index], index);
      } catch (err) {
        throw err; // fail fast
      }
    }
  }

  // Create N workers
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () =>
    worker()
  );

  await Promise.all(workers);
  return results;
}

/**
 * Public: discoverAgents
 */
export async function discoverAgents(opts?: DiscoverOptions): Promise<AgentInfo[]> {
  const options = { ...DEFAULT_OPTS, ...(opts || {}) };

  // 1) load registry
  let registryArr = await loadRegistry(options.registryUrl, options.timeoutMs).catch(() => null);

  // if fetch fails or not returned, fallback to empty array
  if (!registryArr) registryArr = [];

  // normalize: ensure each entry has id & url
  const normalized = registryArr
    .filter((a) => a && (a.id || a.name) && (a.url || a.endpoint))
    .map((a: any) => ({
      id: String(a.id || a.name),
      name: a.name || a.id || undefined,
      url: String(a.url || a.endpoint),
      capabilities: Array.isArray(a.capabilities) ? a.capabilities.slice() : [],
      meta: a.meta || {},
    }));

  // if registry empty -> fallback to embedded defaults (keeps offline dev possible)
  const fallbackDefaults: AgentInfo[] = normalized.length === 0 ? [
    {
      id: "wallet-agent",
      name: "WalletAnalysisAgent",
      url: "https://wallet-agent.icma.workers.dev",
      capabilities: [],
    },
    {
      id: "report-agent",
      name: "ReportGenerationAgent",
      url: "https://report-agent-worker.icma.workers.dev",
      capabilities: [],
    },
  ] : normalized;

  if (!options.probeEndpoints) return fallbackDefaults;

  // 2) probe endpoints in parallel with concurrency limit
  const probedResults = await pMap(
    fallbackDefaults,
    options.probeConcurrency,
    async (agent) => {
      try {
        const data = await probeCapabilities(agent.url, options.timeoutMs, options.retryAttempts);
        if (data && Array.isArray(data.capabilities)) {
          return {
            id: agent.id,
            name: data.name || agent.name,
            url: agent.url,
            capabilities: data.capabilities,
            meta: { ...agent.meta, ...(data.meta || {}) },
          } as AgentInfo;
        }
      } catch {
        // ignore
      }
      // if probe failed, return original info
      return agent;
    }
  );

  // dedupe by id (keep latest)
  const mapById = new Map<string, AgentInfo>();
  for (const a of probedResults) mapById.set(a.id, a);
  return Array.from(mapById.values());
}
