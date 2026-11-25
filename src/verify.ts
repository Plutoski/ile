import { fromDataSuffix } from "@celo/attribution-tags";
import { erc20Abi, getAddress, parseEventLogs, type Hash, type PublicClient } from "viem";
import { ATTRIBUTION_CODE, TEXTILE, TOKENS } from "./config.js";
import type { Ledger } from "./ledger.js";

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

      const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs });
      if (step === "swap") {
        const paid = transfers.filter((t) => getAddress(t.address) === getAddress(TOKENS.USDT) && getAddress(t.args.from) === agent)
          .reduce((s, t) => s + t.args.value, 0n);
        const got = transfers.filter((t) => getAddress(t.address) === getAddress(TOKENS.CNGN) && getAddress(t.args.to) === agent)
          .reduce((s, t) => s + t.args.value, 0n);
        if (getAddress(tx.to!) !== getAddress(TEXTILE.reactor)) problems.push("swap did not go to Textile's reactor");
        if (paid !== BigInt(p.usdtSpent)) problems.push(`USD₮ paid ${paid}, ledger says ${p.usdtSpent}`);
        if (got < BigInt(p.cngnAmount)) problems.push(`cNGN received ${got}, ledger says ${p.cngnAmount}`);
      }
      if (step === "transfer") {
        const sent = transfers.find((t) => getAddress(t.address) === getAddress(TOKENS.CNGN) && getAddress(t.args.to) === getAddress(p.recipient));
        if (!sent) problems.push("no cNGN transfer to the recipient");
        else if (sent.args.value !== BigInt(p.cngnAmount)) problems.push(`sent ${sent.args.value} cNGN, ledger says ${p.cngnAmount}`);
      }
      checks.push({ billId: p.billId, step, hash, ok: problems.length === 0, problems });
    }
  }
  return checks;
}
