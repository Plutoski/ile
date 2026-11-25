import type { Address } from "viem";
import type { ChainOps } from "./chain.js";
import { TEXTILE, TOKENS } from "./config.js";
import { periodOf, type Bill, type Household } from "./household.js";
import { findPayment, recordDecision, usdtSpentInMonth, type Ledger, type Payment } from "./ledger.js";
import { checkQuote, fmtUsdt } from "./policy.js";
import type { ReferenceRate } from "./rate.js";
import { TextileError, type FirmQuote, type TextileClient } from "./textile.js";

export interface PayDeps {
  chain: ChainOps;
  textile: Pick<TextileClient, "requestQuote" | "cancel" | "submit">;
  reference: () => Promise<ReferenceRate | null>;
  ledger: Ledger;
  persist: () => Promise<void>;
  now?: () => Date;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Pay even when no independent reference rate is available. Off by default. */
  allowNoReference?: boolean;
}

export type PayOutcome =
  | { kind: "paid"; payment: Payment }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

const MAX_QUOTE_ATTEMPTS = 3;

export async function payBill(bill: Bill, household: Household, deps: PayDeps): Promise<PayOutcome> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const period = periodOf(bill, now());
  const { chain, ledger } = deps;

  const skip = async (reason: string): Promise<PayOutcome> => {
    log(`skip ${bill.id}: ${reason}`);
    recordDecision(ledger, { billId: bill.id, period, action: "skipped", reason }, now());
    await deps.persist();
    return { kind: "skipped", reason };
  };
  const fail = async (reason: string): Promise<PayOutcome> => {
    log(`FAIL ${bill.id}: ${reason}`);
    recordDecision(ledger, { billId: bill.id, period, action: "failed", reason }, now());
    await deps.persist();
    return { kind: "failed", reason };
  };

  const recipient = household.recipients.find((r) => r.id === bill.recipientId);
  if (!recipient) return skip(`unknown recipient ${bill.recipientId}`);

  const existing = findPayment(ledger, bill.id, period);
  if (existing?.status === "paid") return { kind: "skipped", reason: "already paid this period" };

  try {
    // A previous run bought the naira but stopped before sending it: finish that, never buy twice.
    if (existing?.status === "swapped") {
      log(`resume ${bill.id}: cNGN already bought in rfq ${existing.rfqId}, sending it now`);
      return await deliver(existing, recipient.address, deps);
    }

    const cngnDecimals = await chain.decimals(TOKENS.CNGN);
    const buyAmount = BigInt(bill.amountNgn) * 10n ** BigInt(cngnDecimals);

    const ref = await deps.reference();
    if (!ref && !deps.allowNoReference) return skip("no trustworthy USD/NGN reference rate right now; will retry next run");

    let firm: FirmQuote | null = null;
    let rate = 0;
    let spreadPct: number | null = null;
    let lastReason = "no quote";

    for (let attempt = 1; attempt <= MAX_QUOTE_ATTEMPTS && !firm; attempt++) {
      const result = await deps.textile.requestQuote({ sellToken: TOKENS.USDT, buyToken: TOKENS.CNGN, buyAmount });
      if (result.status === "no_quote") {
        lastReason = `Textile had no quote (${result.reason})`;
        if (result.reason === "no_makers_online") break; // retrying in a loop will not help
        await sleep(Math.min(result.retryAfterMs ?? 3_000, 15_000));
        continue;
      }
      const verdict = checkQuote({
        firm: result.firm, agent: chain.agent, requestedCngn: buyAmount, cngnDecimals,
        policy: household.policy, spentThisMonth: usdtSpentInMonth(ledger, now()),
        referenceRate: ref?.rate ?? null, now: now().getTime(),
      });
      if (!verdict.ok) {
        await deps.textile.cancel(result.firm.rfqId, result.firm.claimToken).catch(() => {});
        // Cap and rate refusals are decisions, not glitches: do not re-ask in the same run.
        return skip(verdict.reason);
      }
      firm = result.firm;
      rate = verdict.rate;
      spreadPct = verdict.spreadPct;
    }
    if (!firm) return skip(lastReason);

    const takerPays = BigInt(firm.quote.takerPays);
    log(`quote ${firm.rfqId}: ₦${bill.amountNgn} for ${fmtUsdt(takerPays)} USD₮ (₦${rate.toFixed(2)}/$${spreadPct === null ? "" : `, ${spreadPct.toFixed(2)}% vs official`})`);

    const usdtBalance = await chain.balance(TOKENS.USDT);
    if (usdtBalance < takerPays) {
      await deps.textile.cancel(firm.rfqId, firm.claimToken).catch(() => {});
      return skip(`agent holds ${fmtUsdt(usdtBalance)} USD₮, needs ${fmtUsdt(takerPays)}`);
    }

    // Approve exactly what this swap needs. USD₮ refuses a non-zero to non-zero change, so reset first.
    let approveHash: `0x${string}` | undefined;
    const allowance = await chain.allowance(TOKENS.USDT, TEXTILE.reactor);
    if (allowance < takerPays) {
      if (allowance > 0n) await chain.approve(TOKENS.USDT, TEXTILE.reactor, 0n);
      approveHash = await chain.approve(TOKENS.USDT, TEXTILE.reactor, takerPays);
      log(`approved ${fmtUsdt(takerPays)} USD₮ to Textile: ${approveHash}`);
    }

    if (Date.parse(firm.quote.expiresAt) - now().getTime() < TEXTILE.expirySafetyMs) {
      await deps.textile.cancel(firm.rfqId, firm.claimToken).catch(() => {});
      return fail("quote expired while the approval confirmed; next run will re-quote");
    }

    const swapHash = await chain.send({ to: firm.transactions.swap.to, data: firm.transactions.swap.data });
    // Read the delivery from the swap's own receipt. A balance read here can hit a node one block behind.
    const received = await chain.receivedIn(TOKENS.CNGN, swapHash);
    log(`swapped: ${swapHash} (+${received} cNGN atomic)`);
    if (received < buyAmount) throw new Error(`swap ${swapHash} delivered ${received} cNGN, expected ${buyAmount}; check it on celoscan before rerunning`);

    const stamp = now().toISOString();
    const payment: Payment = {
      billId: bill.id, period, recipientId: recipient.id, recipient: recipient.address,
      amountNgn: bill.amountNgn, usdtSpent: takerPays.toString(), usdtFee: firm.quote.feeAmount,
      cngnAmount: buyAmount.toString(), rate, referenceRate: ref?.rate ?? null, rfqId: firm.rfqId,
      txs: { ...(approveHash ? { approve: approveHash } : {}), swap: swapHash },
      status: "swapped", createdAt: stamp, updatedAt: stamp,
    };
    ledger.payments.push(payment);
    await deps.persist(); // the naira is bought: from here on, a rerun only delivers it

    await deps.textile.submit(firm.rfqId, firm.claimToken, swapHash)
      .catch((e) => log(`warn: could not report swap to Textile (${(e as Error).message}); settlement is unaffected`));

    return await deliver(payment, recipient.address, deps, true);
  } catch (err) {
    const msg = err instanceof TextileError && /insufficient/i.test(err.message)
      ? "agent wallet does not hold enough USD₮ for this bill"
      : (err as Error).message.split("\n")[0]!;
    return fail(msg);
  }
}

/**
 * Send bought naira to the recipient. Right after a swap we already know the
 * cNGN arrived (from the receipt), so we skip a balance read that could be stale.
 * When resuming a stopped run, check the balance first.
 */
async function deliver(payment: Payment, to: Address, deps: PayDeps, justSwapped = false): Promise<PayOutcome> {
  const now = deps.now ?? (() => new Date());
  const amount = BigInt(payment.cngnAmount);
  if (!justSwapped) {
    const held = await deps.chain.balance(TOKENS.CNGN);
    if (held < amount) throw new Error(`agent holds ${held} cNGN, needs ${amount} to deliver ${payment.billId}`);
  }
  const hash = await deps.chain.transfer(TOKENS.CNGN, to, amount);
  payment.txs.transfer = hash;
  payment.status = "paid";
  payment.updatedAt = now().toISOString();
  await deps.persist();
  deps.log?.(`paid ${payment.billId}: ₦${payment.amountNgn} to ${to} in ${hash}`);
  return { kind: "paid", payment };
}
