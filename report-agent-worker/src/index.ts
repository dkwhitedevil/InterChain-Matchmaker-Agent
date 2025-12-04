// src/index.ts

export interface Env {
  PINATA_JWT: string; // Your Pinata JWT key
}

interface WalletTx {
  hash: string;
  value: string;
  to: string | null;
  from: string;
  timeStamp: number;
}

interface WalletData {
  address: string;
  balanceEth: string;
  riskScore: number;
  txCount: number;
  recentTxs: WalletTx[];
  timestamp: number;
}

interface PinataResponse {
  IpfsHash: string;
  PinSize: number;
  Timestamp: string;
}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function error(message: string, status = 400): Response {
  return json({ status: "ERROR", message }, status);
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

function generateMarkdownReport(data: WalletData): string {
  return `
# 📄 Wallet Risk & Activity Report
**Address:** ${data.address}  
**Generated:** ${formatDate(Date.now())}

## 🔍 Summary
- **Balance:** ${data.balanceEth} ETH  
- **Risk Score:** ${data.riskScore}/100  
- **Total Transactions:** ${data.txCount}  
- **Original Timestamp:** ${formatDate(data.timestamp)}

## 🧾 Recent Transactions
${
  data.recentTxs.length > 0
    ? data.recentTxs
        .map(
          (t, i) => `
${i + 1}. **Tx Hash:** ${t.hash}  
- Value: ${t.value} ETH  
- From: ${t.from}  
- To: ${t.to}  
- Time: ${formatDate(t.timeStamp * 1000)}
`
        )
        .join("\n")
    : "No recent transactions available."
}

---
### 🔐 Data Integrity
Stored on IPFS using Pinata.
Immutable and content-addressed.
`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/capabilities") {
      return json({
        id: "report-agent",
        name: "ReportGenerationAgent",
        capabilities: ["generate_report", "ipfs_upload"]
      });
    }

    if (url.pathname === "/negotiate") {
      return json({
        status: "ACCEPT",
        message: "Report agent accepts."
      });
    }

    if (url.pathname === "/execute") {
      let body: any;

      try {
        body = await request.json();
      } catch {
        return error("Invalid JSON body");
      }

      const walletData: WalletData = body.walletData;

      if (!walletData || !walletData.address) {
        return error("walletData.address required");
      }

      try {
        // Generate markdown report
        const markdown = generateMarkdownReport(walletData);
        const filename = `report-${walletData.address}.md`;

        const formData = new FormData();
        formData.append(
          "file",
          new Blob([markdown], { type: "text/markdown" }),
          filename
        );

        // Upload to Pinata
        const uploadRes = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.PINATA_JWT}`
          },
          body: formData
        });

        const result = (await uploadRes.json()) as PinataResponse;

        const cid = result.IpfsHash;
        const gatewayUrl = `https://gateway.pinata.cloud/ipfs/${cid}`;

        return json({
          status: "DONE",
          output: {
            cid,
            url: gatewayUrl,
            agent: "ReportGenerationAgent",
            generatedAt: formatDate(Date.now())
          }
        });

      } catch (err: any) {
        return error(err.message || String(err), 500);
      }
    }

    return error("Route not found", 404);
  }
};
