# InterChain Matchmaker Agent (ICMA)

A distributed, multi-agent orchestration system built on Cloudflare Workers for discovering, matching, negotiating with, and executing workflows across multiple autonomous agents.

## 📋 Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Agents](#agents)
- [Getting Started](#getting-started)
- [Deployment](#deployment)
- [API Reference](#api-reference)
- [Workflow Execution](#workflow-execution)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)

---

## Overview

**ICMA** is an orchestration framework that:

1. **Discovers agents** from a registry (`agents.json`)
2. **Probes agent capabilities** to understand what each can do
3. **Matches capabilities** to workflow steps
4. **Negotiates** with agents to confirm participation
5. **Executes workflows** by chaining agents in sequence
6. **Handles failures** with retries and graceful degradation

### Key Features

- ✅ **Multi-agent orchestration** — coordinate multiple independent workers
- ✅ **Cloudflare Workers compatible** — run serverless on Cloudflare's edge
- ✅ **Proxy-aware** — automatically routes `workers.dev` requests via a public proxy to bypass Cloudflare's Worker→Worker fetch restrictions
- ✅ **Concurrent discovery** — probes agent capabilities with configurable concurrency
- ✅ **Type-safe** — full TypeScript support with strict checking
- ✅ **Modular architecture** — separate tools for discovery, matching, negotiation, execution

---

## Architecture

### Components

```
┌─────────────────────────────────────────────────────┐
│            ICMA Orchestrator Worker                 │
│  (icma-orchestrator.icma.workers.dev)               │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │ 1. Discover Agents                          │    │
│  │    - Load agents.json                       │    │
│  │    - Normalize endpoints                    │    │
│  └─────────────────────────────────────────────┘    │ 
│                        ↓                            │
│  ┌─────────────────────────────────────────────┐    │
│  │ 2. Probe Capabilities                       │    │
│  │    - Fetch /capabilities from each agent    │    │
│  │    - Concurrent probing (configurable)      │    │ 
│  │    - Handle failures with retries           │    │
│  └─────────────────────────────────────────────┘    │ 
│                        ↓                            │
│  ┌─────────────────────────────────────────────┐    │
│  │ 3. Match Capabilities → Workflow Steps      │    │
│  │    - wallet_scan → wallet-agent             │    │
│  │    - generate_report → report-agent         │    │
│  └─────────────────────────────────────────────┘    │
│                        ↓                            │
│  ┌─────────────────────────────────────────────┐    │
│  │ 4. Negotiate with Agents                    │    │
│  │    - POST /negotiate to confirm             │    │
│  │    - Fail fast if negotiation rejected      │    │
│  └─────────────────────────────────────────────┘    │
│                        ↓                            │
│  ┌─────────────────────────────────────────────┐    │
│  │ 5. Execute Workflow                         │    │
│  │    - Chain agents sequentially              │    │
│  │    - wallet output → report input           │    │
│  │    - Retry on failure                       │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
└─────────────────────────────────────────────────────┘
         ↓                              ↓
   ┌─────────────┐              ┌──────────────┐
   │ wallet-agent│              │ report-agent │
   │(wallet scan)│              │(gen. report) │
   └─────────────┘              └──────────────┘
```

### Proxy Strategy

Since Cloudflare Workers cannot directly fetch other Cloudflare Worker endpoints (`workers.dev`), ICMA uses a **public proxy** to forward requests:

- **Direct fetch** (GitHub/public URLs): `https://example.com/path` → fetched directly
- **Workers.dev endpoint**: `https://agent.workers.dev/path` → `https://thingproxy.freeboard.io/fetch/https://agent.workers.dev/path`

This allows the orchestrator Worker to reach agent Workers without Cloudflare 1042 errors.

---

## Project Structure

```
InterChain-Matchmaker-Agent/
├── README.md                          # This file
├── agents.json                        # Global agent registry
├── package.json                       # Root package (monorepo setup)
│
├── icma/                              # ICMA Orchestrator Worker
│   ├── src/
│   │   ├── index.ts                   # Main orchestrator logic
│   │   └── tools/
│   │       ├── discoverAgents.ts      # Agent discovery & probing
│   │       ├── matchCapabilities.ts   # Capability matching to steps
│   │       ├── negotiateAgents.ts     # Negotiation logic
│   │       └── executeWorkflow.ts     # Workflow execution
│   ├── assets/
│   │   └── agents.json                # Agent registry (default)
│   ├── public/
│   │   ├── wallet-cap.json            # Wallet agent capabilities (static)
│   │   └── report-cap.json            # Report agent capabilities (static)
│   ├── tsconfig.json                  # TypeScript config
│   ├── wrangler.toml                  # Cloudflare Worker config
│   └── package.json
│
├── wallet-agent/                      # Wallet Analysis Worker
│   ├── src/
│   │   └── index.ts                   # Wallet scanning logic
│   ├── tsconfig.json
│   ├── wrangler.toml
│   └── package.json
│
└── report-agent-worker/               # Report Generation Worker
    ├── src/
    │   └── index.ts                   # Report generation logic
    ├── tsconfig.json
    ├── wrangler.toml
    └── package.json
```

---

## Agents

### Wallet Agent (`wallet-agent`)

**Purpose:** Scan an Ethereum wallet and extract transaction history + risk metrics.

**Endpoints:**
- `GET /capabilities` — Returns supported capabilities
- `POST /negotiate` — Negotiates participation (accepts/rejects proposals)
- `POST /execute` — Executes wallet scan given an address

**Execute Request:**
```json
{
  "address": "0xaabe9725ba9f7e0c0c388ddb33076fc53d2a8813"
}
```

**Execute Response:**
```json
{
  "status": "DONE",
  "output": {
    "address": "0x...",
    "balanceEth": "1.5",
    "txCount": 42,
    "recentTxs": [...],
    "riskScore": 35,
    "timestamp": 1733700000000
  }
}
```

**Environment Variables:**
- `ALCHEMY_RPC_URL` — Alchemy or Infura JSON-RPC endpoint
- `ETHERSCAN_API_KEY` — Etherscan API key for transaction history

---

### Report Agent (`report-agent-worker`)

**Purpose:** Generate a comprehensive report from wallet data.

**Endpoints:**
- `GET /capabilities` — Returns supported capabilities
- `POST /negotiate` — Negotiates participation
- `POST /execute` — Generates report from wallet output

**Execute Request:**
```json
{
  "walletData": {
    "address": "0x...",
    "balanceEth": "1.5",
    ...
  }
}
```

**Execute Response:**
```json
{
  "status": "DONE",
  "output": {
    "report": "...",
    "summary": "...",
    "timestamp": 1733700000000
  }
}
```

---

## Getting Started

### Prerequisites

- **Node.js** 18+ and **npm** or **pnpm**
- **Wrangler CLI** v4.32.0+ (`npm install -g @wrangler/cli` or use local version)
- **Cloudflare account** with a Workers plan (free tier supported)
- **Alchemy/Infura RPC URL** for Ethereum access (wallet-agent)
- **Etherscan API Key** for transaction history (wallet-agent)

### Installation

1. **Clone the repo:**
   ```bash
   git clone https://github.com/dkwhitedevil/InterChain-Matchmaker-Agent.git
   cd InterChain-Matchmaker-Agent
   ```

2. **Install dependencies:**
   ```bash
   pnpm install
   # or: npm install
   ```

3. **Configure environment variables:**

   For `wallet-agent`, create a `.env` or set secrets via Wrangler:
   ```bash
   cd wallet-agent
   wrangler secret put ALCHEMY_RPC_URL
   wrangler secret put ETHERSCAN_API_KEY
   ```

   (Repeat for `report-agent-worker` if needed.)

4. **Update `agents.json`** (if running locally):
   ```json
   [
     {
       "id": "wallet-agent",
       "name": "WalletAnalysisAgent",
       "endpoint": "https://wallet-agent.icma.workers.dev",
       "capabilities": []
     },
     {
       "id": "report-agent",
       "name": "ReportGenerationAgent",
       "endpoint": "https://report-agent-worker.icma.workers.dev",
       "capabilities": []
     }
   ]
   ```

---

## Deployment

### Deploy all Workers

```bash
# From project root
pnpm --filter icma run build
pnpm --filter wallet-agent run build
pnpm --filter report-agent-worker run build

# Deploy to Cloudflare
pnpm --filter icma run deploy
pnpm --filter wallet-agent run deploy
pnpm --filter report-agent-worker run deploy
```

Or manually:
```bash
cd icma && wrangler deploy
cd ../wallet-agent && wrangler deploy
cd ../report-agent-worker && wrangler deploy
```

### Verify Deployment

```bash
# Check orchestrator is live
curl https://icma-orchestrator.icma.workers.dev/

# Test wallet agent
curl https://icma-orchestrator.icma.workers.dev/test-wallet

# Test report agent
curl https://icma-orchestrator.icma.workers.dev/test-report
```

---

## API Reference

### Orchestrator Endpoints

#### `GET /`
Returns usage/help text.

**Response:**
```
ICMA Orchestrator Worker
GET  /capabilities
GET  /test-wallet
GET  /test-report
POST /negotiate
POST /execute
```

---

#### `GET /capabilities`
Returns the orchestrator's own capabilities.

**Response:**
```json
{
  "id": "icma-orchestrator",
  "name": "ICMA Orchestrator",
  "capabilities": ["orchestrate_workflow", "discover_agents"]
}
```

---

#### `GET /test-wallet`
Proxies to wallet-agent `/capabilities` endpoint (useful for debugging proxy connectivity).

**Response:**
```json
{
  "id": "wallet-agent",
  "name": "WalletAnalysisAgent",
  "capabilities": ["wallet_scan", "balance_data", "tx_history", "risk_score"]
}
```

---

#### `GET /test-report`
Proxies to report-agent `/capabilities` endpoint.

**Response:**
```json
{
  "id": "report-agent",
  "name": "ReportGenerationAgent",
  "capabilities": ["generate_report", "risk_summary"]
}
```

---

#### `POST /negotiate`
Orchestrator accepts proposals (always returns acceptance).

**Request:**
```json
{}
```

**Response:**
```json
{
  "status": "ACCEPT",
  "message": "ICMA orchestrator accepts proposals."
}
```

---

#### `POST /execute`
**Main workflow execution endpoint.** Orchestrates the full agent pipeline.

**Request:**
```json
{
  "address": "0xaabe9725ba9f7e0c0c388ddb33076fc53d2a8813"
}
```

**Response (Success):**
```json
{
  "status": "DONE",
  "wallet": {
    "address": "0x...",
    "balanceEth": "1.5",
    "txCount": 42,
    "recentTxs": [...],
    "riskScore": 35,
    "timestamp": 1733700000000
  },
  "report": {
    "report": "Risk analysis complete...",
    "summary": "...",
    "timestamp": 1733700000000
  },
  "logs": [
    "2025-12-08T10:00:00Z - Discovering agents...",
    "2025-12-08T10:00:01Z - Probing wallet-agent capabilities...",
    ...
  ],
  "agents": [
    {
      "step": "wallet_scan",
      "id": "wallet-agent",
      "endpoint": "https://wallet-agent.icma.workers.dev"
    },
    {
      "step": "generate_report",
      "id": "report-agent",
      "endpoint": "https://report-agent-worker.icma.workers.dev"
    }
  ],
  "timestamp": 1733700000000
}
```

**Response (Failure):**
```json
{
  "status": "ERROR",
  "message": "Agent wallet-agent failed at step wallet_scan",
  "logs": [
    {
      "step": "wallet_scan",
      "agentId": "wallet-agent",
      "success": false,
      "statusCode": 500,
      "durationMs": 2500,
      "error": "ALCHEMY_RPC_URL not configured"
    }
  ]
}
```

---

## Workflow Execution

### Step-by-step flow for `POST /execute`

1. **Parse input** → Extract Ethereum address
2. **Discover agents** → Load and parse `agents.json`
3. **Probe capabilities** → Call `/capabilities` on each agent (concurrent, with retries)
4. **Match capabilities** → Map workflow steps to agents:
   - `wallet_scan` → `wallet-agent`
   - `generate_report` → `report-agent`
5. **Validate coverage** → Ensure all workflow steps have matching agents
6. **Negotiate** → POST `/negotiate` to confirm participation
7. **Execute sequence:**
   - `wallet-agent /execute` with `{ address }` → get wallet output
   - `report-agent /execute` with `{ walletData: walletOutput }` → get report
8. **Return final output** with all logs and timing

### Error Handling

- **Missing agent** → Return 500 with "Missing agents for steps..."
- **Negotiation fails** → Return 502 with agent IDs that refused
- **Execution fails** → Return 502 with step name and error details
- **Timeout** → Retry up to `retryAttempts` times, then fail
- **Proxy error** → Return descriptive error

---

## Configuration

### `icma/tsconfig.json`

```jsonc
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "./dist",
    "isolatedModules": true,
    "types": ["node", "@cloudflare/workers-types", "./worker-configuration.d.ts"]
  },
  "include": ["src"]
}
```

### `icma/wrangler.toml`

```toml
name = "icma-orchestrator"
main = "src/index.ts"
compatibility_date = "2025-12-05"

[env.production]
route = "icma-orchestrator.icma.workers.dev/*"
zone_id = "your-zone-id"
```

### `icma/assets/agents.json`

Registry of available agents. Update endpoints to match your deployment:

```json
[
  {
    "id": "wallet-agent",
    "name": "WalletAnalysisAgent",
    "endpoint": "https://wallet-agent.icma.workers.dev",
    "capabilities": []
  },
  {
    "id": "report-agent",
    "name": "ReportGenerationAgent",
    "endpoint": "https://report-agent-worker.icma.workers.dev",
    "capabilities": []
  }
]
```

### Environment Variables

**Wallet Agent (`wallet-agent`):**
- `ALCHEMY_RPC_URL` (required) — e.g., `https://eth-mainnet.alchemyapi.io/v2/YOUR_KEY`
- `ETHERSCAN_API_KEY` (required) — Etherscan API key for transaction history

Set via Wrangler:
```bash
wrangler secret put ALCHEMY_RPC_URL
wrangler secret put ETHERSCAN_API_KEY
```

---

## Troubleshooting

### 1. **Error: `Agent wallet-agent failed at step wallet_scan` (HTTP 403)**

**Cause:** The proxy URL is unreachable or the agent endpoint is misconfigured.

**Solution:**
- Verify `agents.json` contains correct `workers.dev` endpoints
- Test proxy directly:
  ```bash
  curl -X POST 'https://thingproxy.freeboard.io/fetch/https://wallet-agent.icma.workers.dev/execute' \
    -H 'content-type: application/json' \
    -d '{"address":"0xaabe9725ba9f7e0c0c388ddb33076fc53d2a8813"}'
  ```
- If proxy is unreliable, deploy your own Cloudflare Worker proxy or use a different proxy service.

---

### 2. **Error: `Missing agents for steps: wallet_scan, generate_report`**

**Cause:** Agent discovery failed or agents are not responding to `/capabilities`.

**Solution:**
- Verify agents are deployed and online:
  ```bash
  curl https://wallet-agent.icma.workers.dev/capabilities
  curl https://report-agent-worker.icma.workers.dev/capabilities
  ```
- Check orchestrator logs for probe errors
- Increase `timeoutMs` in `discoverAgents()` call if agents are slow

---

### 3. **Error: `Cannot find module './discoverAgents'`**

**Cause:** TypeScript is not resolving the tools correctly.

**Solution:**
- Ensure all files exist in `icma/src/tools/`
- Run `pnpm install` to update dependencies
- Clear TypeScript cache: `rm -rf icma/.tsbuildinfo`

---

### 4. **Wallet agent returns: `Invalid Ethereum address`**

**Cause:** Address format is incorrect.

**Solution:**
- Ensure address is a valid 40-character hex string prefixed with `0x`
- Example: `0xaabe9725ba9f7e0c0c388ddb33076fc53d2a8813`

---

### 5. **Wallet agent returns: `ALCHEMY_RPC_URL not configured`**

**Cause:** Environment variable not set.

**Solution:**
- Set the secret:
  ```bash
  cd wallet-agent
  wrangler secret put ALCHEMY_RPC_URL
  # Enter your URL at the prompt
  wrangler deploy
  ```

---

## Development

### Local Testing

Run Wrangler dev mode for the orchestrator:

```bash
cd icma
wrangler dev
# Server runs at http://localhost:8787
```

Test the `/execute` endpoint:
```bash
curl -X POST http://localhost:8787/execute \
  -H "content-type: application/json" \
  -d '{"address":"0xaabe9725ba9f7e0c0c388ddb33076fc53d2a8813"}'
```

### Type Checking

```bash
cd icma
pnpm tsc --noEmit
```

### Building

```bash
cd icma
pnpm build
```

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit changes: `git commit -am 'Add feature'`
4. Push to branch: `git push origin feature/my-feature`
5. Submit a pull request

---

## License

MIT License — see LICENSE file for details.

---

## Support

For issues, questions, or suggestions:
- Open a GitHub issue: https://github.com/dkwhitedevil/InterChain-Matchmaker-Agent/issues
- Contact the maintainer

---

**Last Updated:** December 8, 2025  
**Version:** 0.1.0
