export interface Env {
  WALLET: Fetcher;   // service binding
  REPORT: Fetcher;   // service binding
}

export default {
  async fetch(request: Request, env: Env) {
    try {
      if (request.method !== "POST") {
        return Response.json({
          ok: true,
          message: "POST wallet input to run orchestrator"
        });
      }

      const body: any = await request.json().catch(() => ({}));
      const address = body?.input?.address || body?.address || body?.wallet;
      if (!address) {
        return Response.json({ error: "Missing address" }, { status: 400 });
      }

      const logs: string[] = [];
      function log(msg: string) {
        logs.push(`${new Date().toISOString()} - ${msg}`);
      }

      log("=== START WORKFLOW ===");

      // 1️⃣ WALLET SCAN
      log("Calling WALLET /capabilities (service binding)");
      const walletCapsRes = await env.WALLET.fetch("/capabilities");
      const walletCaps: any = await walletCapsRes.json().catch(() => ({}));
      log("Wallet capabilities: " + JSON.stringify(walletCaps));

      log("Calling WALLET /execute");
      const walletRes = await env.WALLET.fetch("/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address })
      });
      const walletOutput: any = await walletRes.json().catch(() => ({}));
      log("Wallet output received");

      if (walletOutput.status !== "DONE") {
        return Response.json({
          status: "FAILED",
          step: "wallet_scan",
          walletOutput,
          logs
        });
      }

      // 2️⃣ REPORT GENERATION
      log("Calling REPORT /capabilities (service binding)");
      const reportCapsRes = await env.REPORT.fetch("/capabilities");
      const reportCaps: any = await reportCapsRes.json().catch(() => ({}));
      log("Report capabilities: " + JSON.stringify(reportCaps));

      log("Calling REPORT /execute");
      const reportRes = await env.REPORT.fetch("/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          walletData: walletOutput.output
        })
      });
      const reportOutput: any = await reportRes.json().catch(() => ({}));
      log("Report output received");

      if (reportOutput.status !== "DONE") {
        return Response.json({
          status: "FAILED",
          step: "generate_report",
          reportOutput,
          logs
        });
      }

      log("=== WORKFLOW COMPLETE ===");

      return Response.json({
        status: "DONE",
        wallet: walletOutput.output,
        report: reportOutput.output,
        logs
      });
    } catch (err: any) {
      return Response.json(
        { status: "FAILED", error: String(err) },
        { status: 500 }
      );
    }
  }
};
