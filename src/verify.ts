import { fromDataSuffix } from "@celo/attribution-tags";
import { getAddress, type Hash, type PublicClient } from "viem";
import { ATTRIBUTION_CODE, TEXTILE, TOKENS } from "./config.js";
import type { Ledger } from "./ledger.js";
import { tokenFlows } from "./receipts.js";

export interface TxCheck { billId: string; step: string; hash: Hash; ok: boolean; problems: string[] }

/**
 * Rebuild every claim in the ledger from the chain alone: each transaction
 * succeeded, came from the agent, carries the attribution tag, and moved the
 * amounts the ledger says it did. Anyone can run this with no keys.
 */
export async function verifyLedger(client: PublicClient, ledger: Ledger): Promise<TxCheck[]> {
  if (!ledger.agent) throw new Error("ledger has no agent address yet");
  const agent = getAddress(ledger.agent);
  const checks: TxCheck[] = [];

  for (const p of ledger.payments) {
    const steps = Object.entries(p.txs) as [string, Hash][];
    for (const [step, hash] of steps) {
      const problems: string[] = [];
      const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
      if (receipt.status !== "success") problems.push("reverted");
      if (getAddress(tx.from) !== agent) problems.push(`sent by ${tx.from}, not the agent`);
      const tag = fromDataSuffix(tx.input);
      if (!tag?.codes.includes(ATTRIBUTION_CODE)) problems.push("missing attribution tag");

      if (step === "swap") {
        // Gas paid in USD₮ shows up as transfers too; tokenFlows leaves those out.
        const paid = tokenFlows(receipt.logs, TOKENS.USDT, agent).sent;
        const got = tokenFlows(receipt.logs, TOKENS.CNGN, agent).received;
        if (getAddress(tx.to!) !== getAddress(TEXTILE.reactor)) problems.push("swap did not go to Textile's reactor");
        if (paid !== BigInt(p.usdtSpent)) problems.push(`USD₮ paid ${paid}, ledger says ${p.usdtSpent}`);
        if (got < BigInt(p.cngnAmount)) problems.push(`cNGN received ${got}, ledger says ${p.cngnAmount}`);
      }
      if (step === "transfer") {
        const sent = tokenFlows(receipt.logs, TOKENS.CNGN, agent).to.find((t) => t.address === getAddress(p.recipient));
        if (!sent) problems.push("no cNGN transfer to the recipient");
        else if (sent.amount !== BigInt(p.cngnAmount)) problems.push(`sent ${sent.amount} cNGN, ledger says ${p.cngnAmount}`);
      }
      checks.push({ billId: p.billId, step, hash, ok: problems.length === 0, problems });
    }
  }
  return checks;
}
