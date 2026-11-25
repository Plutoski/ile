import { fromDataSuffix } from "@celo/attribution-tags";
import { getAddress, type Address, type Hash, type Log } from "viem";
import { ATTRIBUTION_CODE, TEXTILE, TOKENS } from "./config.js";
import { periodOf, type Bill, type Household } from "./household.js";
import type { Ledger, Payment } from "./ledger.js";
import { effectiveRate } from "./policy.js";
import { tokenFlows } from "./receipts.js";

export interface SwapEvidence {
  hash: Hash;
  from: Address;
  to: Address | null;
  input: `0x${string}`;
  status: "success" | "reverted";
  logs: Log[];
}

/**
 * Record a Textile swap the agent already completed but could not record
 * (for example, a run that stopped right after the swap). Every claim is
 * checked against the chain before anything is written; the payment is then
 * marked "swapped", so the next pay run only delivers the naira and never
 * buys it a second time.
 */
export function adoptSwap(p: {
  ledger: Ledger; household: Household; bill: Bill; agent: Address;
  swap: SwapEvidence; cngnDecimals: number; now: Date;
}): Payment {
  const { ledger, bill, swap, agent } = p;
  const period = periodOf(bill, p.now);
  const recipient = p.household.recipients.find((r) => r.id === bill.recipientId);
  if (!recipient) throw new Error(`bill ${bill.id} has no recipient`);

  if (ledger.payments.some((x) => x.billId === bill.id && x.period === period)) {
    throw new Error(`${bill.id} already has a payment for ${period}; nothing to adopt`);
  }
  if (ledger.payments.some((x) => x.txs.swap.toLowerCase() === swap.hash.toLowerCase())) {
    throw new Error(`swap ${swap.hash} is already recorded for another bill`);
  }
  if (swap.status !== "success") throw new Error("that transaction reverted");
  if (getAddress(swap.from) !== getAddress(agent)) throw new Error("that transaction was not sent by the agent wallet");
  if (!swap.to || getAddress(swap.to) !== getAddress(TEXTILE.reactor)) throw new Error("that transaction is not a Textile swap");
  if (!fromDataSuffix(swap.input)?.codes.includes(ATTRIBUTION_CODE)) throw new Error("that transaction does not carry the attribution tag");

  const cngn = tokenFlows(swap.logs, TOKENS.CNGN, agent);
  const usdt = tokenFlows(swap.logs, TOKENS.USDT, agent);
  const expected = BigInt(bill.amountNgn) * 10n ** BigInt(p.cngnDecimals);
  if (cngn.received !== expected) {
    throw new Error(`swap delivered ${cngn.received} cNGN, but ${bill.id} is for ${expected}`);
  }
  if (usdt.sent === 0n) throw new Error("swap shows no USD₮ leaving the agent");

  // The maker is whoever sent the naira; anything else the agent paid in USD₮ is Textile's fee.
  const makers = new Set(cngn.from);
  const toMaker = usdt.to.filter((t) => makers.has(t.address)).reduce((s, t) => s + t.amount, 0n);
  const stamp = p.now.toISOString();
  const payment: Payment = {
    billId: bill.id, period, recipientId: recipient.id, recipient: recipient.address,
    amountNgn: bill.amountNgn, usdtSpent: usdt.sent.toString(), usdtFee: (usdt.sent - toMaker).toString(),
    cngnAmount: expected.toString(), rate: effectiveRate(expected, p.cngnDecimals, usdt.sent),
    referenceRate: null, rfqId: "recovered-from-chain", txs: { swap: swap.hash },
    status: "swapped", createdAt: stamp, updatedAt: stamp,
  };
  ledger.payments.push(payment);
  return payment;
}
