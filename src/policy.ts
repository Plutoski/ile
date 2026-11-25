import { getAddress, parseUnits, type Address } from "viem";
import { CHAIN_ID, TEXTILE, TOKENS, USDT_DECIMALS } from "./config.js";
import type { Policy } from "./household.js";
import type { FirmQuote } from "./textile.js";

export type Verdict = { ok: true; rate: number; spreadPct: number | null } | { ok: false; reason: string };

export interface QuoteCheckInput {
  firm: FirmQuote;
  agent: Address;
  requestedCngn: bigint;
  cngnDecimals: number;
  policy: Policy;
  /** Atomic USD₮ already committed this month. */
  spentThisMonth: bigint;
  /** Mid-market naira per dollar, or null when no reference could be fetched. */
  referenceRate: number | null;
  now: number;
}

const same = (a: string, b: string) => {
  try { return getAddress(a) === getAddress(b); } catch { return false; }
};

/** Naira received per USD₮ spent, fee included. */
export function effectiveRate(cngnAtomic: bigint, cngnDecimals: number, usdtAtomic: bigint): number {
  if (usdtAtomic === 0n) return 0;
  return (Number(cngnAtomic) / 10 ** cngnDecimals) / (Number(usdtAtomic) / 10 ** USDT_DECIMALS);
}

/**
 * Every rule a quote must pass before any money moves. The checks on
 * addresses matter as much as the money caps: the agent only ever approves
 * Textile's reactor and only sends swaps to it, whatever the API returns.
 */
export function checkQuote(i: QuoteCheckInput): Verdict {
  const { firm, policy } = i;
  const q = firm.quote;
  const { approval, swap } = firm.transactions;

  if (!same(q.taker, i.agent)) return { ok: false, reason: `quote is bound to ${q.taker}, not the agent wallet` };
  if (!same(q.reactor, TEXTILE.reactor)) return { ok: false, reason: `unexpected reactor ${q.reactor}` };
  if (!same(swap.to, TEXTILE.reactor)) return { ok: false, reason: `swap targets ${swap.to}, not Textile's reactor` };
  if (!same(approval.to, TOKENS.USDT)) return { ok: false, reason: `approval targets ${approval.to}, not USD₮` };
  if (swap.chainId !== CHAIN_ID || approval.chainId !== CHAIN_ID) return { ok: false, reason: "transaction is for the wrong chain" };
  if (BigInt(swap.value || "0") !== 0n) return { ok: false, reason: "swap would send native CELO" };
  if (BigInt(q.buyAmount) !== i.requestedCngn) return { ok: false, reason: `quote delivers ${q.buyAmount}, requested ${i.requestedCngn}` };

  const takerPays = BigInt(q.takerPays);
  if (takerPays <= 0n) return { ok: false, reason: "quote has no cost, refusing a malformed quote" };

  const perPayoutCap = parseUnits(String(policy.maxUsdtPerPayout), USDT_DECIMALS);
  if (takerPays > perPayoutCap) {
    return { ok: false, reason: `costs ${fmtUsdt(takerPays)} USD₮, above the ${policy.maxUsdtPerPayout} USD₮ per-bill cap` };
  }
  const monthCap = parseUnits(String(policy.maxUsdtPerMonth), USDT_DECIMALS);
  if (i.spentThisMonth + takerPays > monthCap) {
    return { ok: false, reason: `would bring this month to ${fmtUsdt(i.spentThisMonth + takerPays)} USD₮, above the ${policy.maxUsdtPerMonth} USD₮ monthly cap` };
  }

  const expiresAt = Date.parse(q.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt - i.now < TEXTILE.expirySafetyMs) {
    return { ok: false, reason: "quote expires too soon to execute safely" };
  }

  const rate = effectiveRate(BigInt(q.buyAmount), i.cngnDecimals, takerPays);
  if (i.referenceRate === null) return { ok: true, rate, spreadPct: null };
  const spreadPct = ((i.referenceRate - rate) / i.referenceRate) * 100;
  if (spreadPct > policy.maxSpreadPct) {
    return {
      ok: false,
      reason: `rate ₦${rate.toFixed(2)}/$ is ${spreadPct.toFixed(2)}% below mid-market ₦${i.referenceRate.toFixed(2)}/$ (limit ${policy.maxSpreadPct}%)`,
    };
  }
  return { ok: true, rate, spreadPct };
}

export const fmtUsdt = (atomic: bigint) => (Number(atomic) / 10 ** USDT_DECIMALS).toFixed(4);
