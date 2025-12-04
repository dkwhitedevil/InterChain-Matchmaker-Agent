import { JsonRpcProvider, formatEther, isAddress } from "ethers";

// ---------- Types ----------
export interface Env {
  ALCHEMY_RPC_URL: string;        // RPC URL
  ETHERSCAN_API_KEY: string;      // You must add this!
}

interface ExecuteBody {
  address?: string;
  wallet?: string;
}

interface WalletTx {
  hash: string;
  value: string;
  to: string | null;
  from: string;
  timeStamp: number;
}

interface WalletOutput {
  address: string;
  balanceEth: string;
  txCount: number;
  recentTxs: WalletTx[];
  riskScore: number;
  timestamp: number;
}

// ---------- Utility: JSON Response ----------
function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function error(message: string, status = 400) {
  return json({ status: "ERROR", message }, status);
}

// ---------- Fetch Transaction History from Etherscan ----------
interface EtherscanResponse {
  status: string;
  message: string;
  result: any[];
}

async function getTxHistory(address: string, apiKey: string): Promise<WalletTx[]> {
  const url =
    `https://api.etherscan.io/api?module=account&action=txlist` +
    `&address=${address}&startblock=0&endblock=99999999&page=1&offset=50&sort=desc&apikey=${apiKey}`;

  const res = await fetch(url);

  if (!res.ok) {
    return [];
  }

  // FIX: Add type assertion
  const data = await res.json() as EtherscanResponse;

  if (data.status !== "1" || !Array.isArray(data.result)) {
    return [];
  }

  return data.result.map((tx: any) => ({
    hash: tx.hash,
    value: formatEther(BigInt(tx.value)),
    to: tx.to,
    from: tx.from,
    timeStamp: Number(tx.timeStamp)
  }));
}


// ---------- Risk Scoring ----------
function calculateRisk(balanceEth: number, txCount: number): number {
  let score = 0;
  if (balanceEth > 10) score += 20;
  if (txCount > 100) score += 50;
  else score += txCount / 2;
  return Math.min(score, 100);
}

// ---------- Main Worker ----------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1) Capabilities
    if (path === "/capabilities") {
      return json({
        id: "wallet-agent",
        name: "WalletAnalysisAgent",
        capabilities: ["wallet_scan", "balance_data", "tx_history", "risk_score"]
      });
    }

    // 2) Negotiate
    if (path === "/negotiate" && request.method === "POST") {
      return json({
        status: "ACCEPT",
        message: "Wallet agent accepts the proposal."
      });
    }

    // 3) Execute
    if (path === "/execute" && request.method === "POST") {
      let body: ExecuteBody;

      try {
        body = await request.json();
      } catch {
        return error("Invalid JSON body.");
      }

      const address = (body.address || body.wallet || "").trim();

      if (!address || !isAddress(address)) {
        return error("Invalid Ethereum address.");
      }

      try {
        // FETCH BALANCE
        const provider = new JsonRpcProvider(env.ALCHEMY_RPC_URL);
        const balance = await provider.getBalance(address);
        const balanceEth = formatEther(balance);

        // FETCH TX HISTORY FROM ETHERSCAN
        const txHistory = await getTxHistory(address, env.ETHERSCAN_API_KEY);

        // RISK SCORE
        const risk = calculateRisk(Number(balanceEth), txHistory.length);

        const output: WalletOutput = {
          address,
          balanceEth,
          txCount: txHistory.length,
          recentTxs: txHistory.slice(0, 10),
          riskScore: risk,
          timestamp: Date.now()
        };

        return json({ status: "DONE", output });
      } catch (err: any) {
        return error(err.message || String(err), 500);
      }
    }

    return error("Not found", 404);
  }
};
