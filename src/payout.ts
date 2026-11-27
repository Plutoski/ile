import { getAddress, type Address, type Hash } from "viem";
import type { ChainOps } from "./chain.js";
import { NEVER_LANDED_MS, TEXTILE, TOKENS } from "./config.js";
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
  const noteNonce = async (_hash: Hash, nonce: number) => {
    ledger.lastNonce = Math.max(ledger.lastNonce ?? 0, nonce + 1);
    await deps.persist();
  };

  // A purchase from an earlier period that was never delivered is finished first, so its naira is never stranded.
  const existing = findPayment(ledger, bill.id, period)
    ?? ledger.payments.find((p) => p.billId === bill.id && p.status === "swapped");
  if (existing?.status === "paid") return { kind: "skipped", reason: "already paid this period" };

  try {
    // A previous run broadcast a swap for this bill. Finish from what the chain says it did; never buy twice.
    if (existing?.status === "swapped") {
      const swap = await chain.receiptOf(existing.txs.swap, TOKENS.CNGN);
      const neverLanded = !swap && neverLandedSince(existing.sentAt?.swap ?? existing.createdAt, now());
      if (!swap && !neverLanded) return fail(`swap ${existing.txs.swap} is not on chain yet; the next run checks again`);
      if (neverLanded || !swap!.ok) {
        ledger.payments.splice(ledger.payments.indexOf(existing), 1);
        await deps.persist();
        const what = neverLanded ? "never landed" : "reverted";
        return fail(`swap ${existing.txs.swap} ${what}, so nothing was bought; the next run buys again`);
      }
      if (swap!.received < BigInt(existing.cngnAmount)) {
        return fail(`swap ${existing.txs.swap} delivered ${swap!.received} of ${existing.cngnAmount} cNGN; check it on celoscan, the agent will not buy this bill again`);
      }
      log(`resume ${bill.id}: cNGN already bought in ${existing.txs.swap}, sending it now`);
      return await deliver(existing, recipient.address, deps);
    }

    // A wallet that has sent more than this ledger records means the ledger is out of date
    // (a run from an old copy, or a save that was lost). Buying from it could pay a bill twice.
    if (ledger.lastNonce !== undefined) {
      const sent = await chain.sentCount();
      if (sent > ledger.lastNonce) {
        return fail(`the wallet has sent ${sent - ledger.lastNonce} transaction(s) this ledger does not record; make sure data/ledger.json is the latest before paying`);
      }
    }

    const cngnDecimals = await chain.decimals(TOKENS.CNGN);
    const buyAmount = BigInt(bill.amountNgn) * 10n ** BigInt(cngnDecimals);

    // Backstop: naira in the wallet that no recorded purchase explains means a swap went unrecorded.
    // Buying again would spend twice; a person should adopt that swap instead.
    const owed = ledger.payments.filter((p) => p.status === "swapped").reduce((sum, p) => sum + BigInt(p.cngnAmount), 0n);
    const held = await chain.balance(TOKENS.CNGN);
    if (held - owed >= buyAmount) {
      return fail(`agent holds ${held} cNGN atomic that no recorded payment explains, enough for this bill; a swap may be unrecorded. Find it on celoscan and run "pay ${bill.id}:<swapHash>" instead of buying again`);
    }

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

    // A swap that can still land after the agent has written it off as "never landed" could be bought twice.
    if (deadlineOf(firm.quote.orderDeadline) - now().getTime() > NEVER_LANDED_MS) {
      await deps.textile.cancel(firm.rfqId, firm.claimToken).catch(() => {});
      return skip(`Textile's order stays valid until ${firm.quote.orderDeadline}, longer than the agent waits for a swap`);
    }

    // Approve exactly what this swap needs. USD₮ refuses a non-zero to non-zero change, so reset first.
    let approveHash: `0x${string}` | undefined;
    const allowance = await chain.allowance(TOKENS.USDT, TEXTILE.reactor);
    if (allowance < takerPays) {
      if (allowance > 0n) await chain.approve(TOKENS.USDT, TEXTILE.reactor, 0n, noteNonce);
      approveHash = await chain.approve(TOKENS.USDT, TEXTILE.reactor, takerPays, noteNonce);
      log(`approved ${fmtUsdt(takerPays)} USD₮ to Textile: ${approveHash}`);
    }

    if (Date.parse(firm.quote.expiresAt) - now().getTime() < TEXTILE.expirySafetyMs) {
      await deps.textile.cancel(firm.rfqId, firm.claimToken).catch(() => {});
      return fail("quote expired while the approval confirmed; next run will re-quote");
    }

    // Record the swap the moment it is broadcast. If its confirmation is lost, the next run
    // finds the hash and checks the chain instead of buying again.
    const stamp = now().toISOString();
    const payment: Payment = {
      billId: bill.id, period, recipientId: recipient.id, recipient: recipient.address,
      amountNgn: bill.amountNgn, usdtSpent: takerPays.toString(), usdtFee: firm.quote.feeAmount,
      cngnAmount: buyAmount.toString(), rate, referenceRate: ref?.rate ?? null, rfqId: firm.rfqId,
      txs: { ...(approveHash ? { approve: approveHash } : {}), swap: "0x" },
      status: "swapped", createdAt: stamp, updatedAt: stamp,
    };
    const swapHash = await chain.send({ to: firm.transactions.swap.to, data: firm.transactions.swap.data }, async (hash, nonce) => {
      payment.txs.swap = hash;
      payment.sentAt = { swap: now().toISOString() };
      ledger.payments.push(payment);
      await noteNonce(hash, nonce);
    });
    // Read the delivery from the receipt the confirmation already holds. A balance read here can hit a lagging node.
    const received = (await chain.receiptOf(swapHash, TOKENS.CNGN))?.received ?? 0n;
    log(`swapped: ${swapHash} (+${received} cNGN atomic)`);
    if (received < buyAmount) {
      throw new Error(`swap ${swapHash} delivered ${received} of ${buyAmount} cNGN; recorded, and the agent will not buy this bill again`);
    }

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
 * Send bought naira to the recipient recorded at purchase. The transfer hash is
 * saved the moment it is broadcast; a rerun checks that hash before sending again.
 * Right after a swap the receipt proves the cNGN arrived, so the balance read is skipped.
 */
async function deliver(payment: Payment, to: Address, deps: PayDeps, justSwapped = false): Promise<PayOutcome> {
  const now = deps.now ?? (() => new Date());
  const { chain } = deps;
  const markPaid = async (hash: Hash): Promise<PayOutcome> => {
    payment.txs.transfer = hash;
    payment.status = "paid";
    payment.updatedAt = now().toISOString();
    await deps.persist();
    deps.log?.(`paid ${payment.billId}: ₦${payment.amountNgn} to ${payment.recipient} in ${hash}`);
    return { kind: "paid", payment };
  };

  // A transfer already broadcast decides first: if it landed, the bill is paid, whatever the household file says now.
  let pinned: number | undefined;
  if (payment.txs.transfer) {
    for (const earlier of payment.earlierTransfers ?? []) {
      if ((await chain.receiptOf(earlier, TOKENS.CNGN))?.ok) return markPaid(earlier);
    }
    const sent = await chain.receiptOf(payment.txs.transfer, TOKENS.CNGN);
    if (sent?.ok) return markPaid(payment.txs.transfer);
    if (!sent && !neverLandedSince(payment.sentAt?.transfer ?? payment.updatedAt, now())) {
      throw new Error(`transfer ${payment.txs.transfer} is not on chain yet; the next run checks again`);
    }
    // No receipt after the wait. A transfer has no deadline, so one stuck in a mempool could still land.
    // If its nonce is still free, the resend takes that same nonce: at most one of the two can ever land.
    const n = payment.transferNonce;
    if (!sent && n !== undefined && !(await chain.nonceUsed(n))) {
      pinned = n;
      payment.earlierTransfers = [...(payment.earlierTransfers ?? []), payment.txs.transfer];
    } else {
      delete payment.earlierTransfers; // the nonce went to another transaction, so none of these can land
    }
    delete payment.txs.transfer;
    await deps.persist();
  }

  if (getAddress(to) !== getAddress(payment.recipient)) {
    throw new Error(`the household file now gives ${to}, but the naira was bought for ${payment.recipient}; refusing to guess which address is right`);
  }

  const amount = BigInt(payment.cngnAmount);
  if (!justSwapped) {
    const held = await chain.balance(TOKENS.CNGN);
    if (held < amount) throw new Error(`agent holds ${held} cNGN, needs ${amount} to deliver ${payment.billId}`);
  }
  const hash = await chain.transfer(TOKENS.CNGN, payment.recipient, amount, async (h, nonce) => {
    payment.txs.transfer = h;
    payment.transferNonce = nonce;
    deps.ledger.lastNonce = Math.max(deps.ledger.lastNonce ?? 0, nonce + 1);
    payment.sentAt = { ...payment.sentAt, transfer: now().toISOString() };
    payment.updatedAt = now().toISOString();
    await deps.persist();
  }, pinned);
  return markPaid(hash);
}

/** Textile's order deadline as epoch ms. It may come as an ISO date, unix seconds or unix ms; NaN if none of these. */
function deadlineOf(v: string): number {
  if (!/^\d+$/.test(String(v))) return Date.parse(v);
  const n = Number(v);
  return n > 1e12 ? n : n * 1000;
}

/** True once a recorded transaction has gone unseen long enough that it cannot have landed. */
function neverLandedSince(sentAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(sentAt) > NEVER_LANDED_MS;
}
