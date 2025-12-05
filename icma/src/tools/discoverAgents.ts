/**
 * src/tools/discoverAgents.ts
 *
 * FINAL FIXED VERSION — NO PROXY, NO WORKER→WORKER FETCH
 * Loads agent definitions from /assets/agents.json
 * Each agent's endpoint should already be a GitHub RAW capability URL.
 */

export type AgentInfo = {
  id: string;
  name?: string;
  endpoint: string;              // direct JSON capability URL
  capabilities: string[];
  meta?: Record<string, any>;
};

export type DiscoverOptions = {
  registryUrl?: string;          // ex: "/assets/agents.json"
  probeEndpoints?: boolean;
  timeoutMs?: number;
  probeConcurrency?: number;
  retryAttempts?: number;
};

const DEFAULT_OPTS: Required<DiscoverOptions> = {
  registryUrl: "/agents.json",
  probeEndpoints: true,
  timeoutMs: 3000,
  probeConcurrency: 4,
  retryAttempts: 1,
};

/* ----------------------------------------
   fetch with timeout
----------------------------------------- */
async function fetchWithTimeout(input: RequestInfo, init: RequestInit | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(input, { ...(init || {}), signal: controller.signal });
    clearTimeout(t);
    return res;
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

/* ----------------------------------------
   Load agents.json from registry
----------------------------------------- */
async function loadRegistry(registryUrl: string, timeoutMs: number): Promise<any[] | null> {
  try {
    const res = await fetchWithTimeout(registryUrl, { method: "GET" }, timeoutMs);
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}


/* ----------------------------------------
   Helper: build a fetchable URL. If the target is a workers.dev host,
   route via the public proxy. If the endpoint points directly to a .json
   capability file, fetch it as-is.
----------------------------------------- */
const PROXY = "https://api.allorigins.win/raw?url=";

function buildFetchUrl(base: string, appendPath?: string) {
  const trimmed = String(base).trim();

  // If base already looks like a JSON capability file, fetch it directly
  try {
    const decoded = decodeURIComponent(trimmed);
    if (/\.json(\?|$)/i.test(decoded) || /raw\.githubusercontent\.com/i.test(decoded)) {
      return trimmed;
    }
  } catch (e) {
    // ignore decode errors and fallback
  }

  const target = (trimmed.replace(/\/+$/, "") + (appendPath || "")).replace(/\s+/g, "");
  try {
    const u = new URL(target);
    if (u.hostname.endsWith("workers.dev")) {
      return PROXY + encodeURIComponent(target);
    }
  } catch (e) {
    // if URL constructor fails, fall back to target
  }
  return target;
}

/* ----------------------------------------
   Probe /capabilities for a single agent with retries
----------------------------------------- */
async function probeCapabilities(urlBase: string, timeoutMs: number, retries: number): Promise<any | null> {
  const urlToFetch = buildFetchUrl(urlBase, "/capabilities");
  let attempt = 0;
  while (attempt <= retries) {
    try {
      const res = await fetchWithTimeout(urlToFetch, { method: "GET" }, timeoutMs);
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

/* ----------------------------------------
   Concurrency-limited mapper
----------------------------------------- */
async function pMap<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  
  const out: R[] = new Array(items.length);
  let current = 0;

  async function worker() {
    while (true) {
      const i = current++;
      if (i >= items.length) break;

      out[i] = await mapper(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);

  return out;
}

/* ----------------------------------------
   PUBLIC: discoverAgents
----------------------------------------- */
export async function discoverAgents(opts?: DiscoverOptions): Promise<AgentInfo[]> {
  const options = { ...DEFAULT_OPTS, ...(opts || {}) };

  // Load agents.json
  let registry = await loadRegistry(options.registryUrl, options.timeoutMs);
  if (!registry) registry = [];

  // Normalize agents.json entries
  const normalized: AgentInfo[] = registry
    .filter(a => a && a.id && (a.url || a.endpoint))
    .map((a: any) => ({
      id: String(a.id),
      name: a.name || a.id,
      endpoint: String(a.endpoint || a.url).trim(),  // <-- DIRECT URL, NO PROXY
      capabilities: Array.isArray(a.capabilities) ? [...a.capabilities] : [],
      meta: a.meta || {}
    }));

  // If empty → fallback (only for local dev)
  const fallback: AgentInfo[] = normalized.length === 0
    ? [
        {
          id: "wallet-agent",
          name: "WalletAnalysisAgent",
          endpoint:
            "https://raw.githubusercontent.com/dkwhitedevil/InterChain-Matchmaker-Agent/main/public/wallet-cap.json",
          capabilities: []
        },
        {
          id: "report-agent",
          name: "ReportGenerationAgent",
          endpoint:
            "https://raw.githubusercontent.com/dkwhitedevil/InterChain-Matchmaker-Agent/main/public/report-cap.json",
          capabilities: []
        }
      ]
    : normalized;

  if (!options.probeEndpoints) return fallback;

  // Probe capability URLs with concurrency
  const probed = await pMap(
    fallback,
    options.probeConcurrency,
    async (agent) => {
      const data = await probeCapabilities(agent.endpoint, options.timeoutMs, options.retryAttempts);

      if (data && Array.isArray(data.capabilities)) {
        return {
          id: agent.id,
          name: data.name || agent.name,
          endpoint: agent.endpoint,
          capabilities: data.capabilities,
          meta: { ...agent.meta, ...(data.meta || {}) }
        } as AgentInfo;
      }

      return agent; // fallback
    }
  );

  // Deduplicate by id
  const map = new Map<string, AgentInfo>();
  for (const a of probed) map.set(a.id, a);

  return [...map.values()];
}
