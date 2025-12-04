import { discover_agents } from "./tools/discoverAgents";
import { match_agents } from "./tools/matchAgents";
import { negotiate_terms } from "./tools/negotiate";
import { execute_workflow } from "./tools/executeWorkflow";

export default {
  async onMessage(input: string) {
    console.log("USER INPUT:", input);
    const agents = await discover_agents({ probeEndpoints: true, timeoutMs: 3000, edenlayerUrl: process.env.EDENLAYER_URL });
    const plan = await match_agents({ goal: input, agents });
    const negotiation = await negotiate_terms({ workflow: plan.workflow, proposalTemplate: { price: "0.00001 ETH" } });
    const executeRes = await execute_workflow({ workflow: plan.workflow, parallel: false });
    return {
      message: "ICMA finished",
      plan,
      negotiation,
      executeRes
    };
  }
};
