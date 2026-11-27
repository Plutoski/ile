import { readFile, rename, writeFile } from "node:fs/promises";
import type { Address, Hash } from "viem";
import { lagosMonth } from "./household.js";

/**
 * Lifecycle of one bill payment. Each step is written to disk before the
 * next starts, so a crash or a cancelled run resumes where it stopped and
 * never pays a bill twice.
 *
 *   swapped -> paid        (cNGN bought, then sent to the recipient)
 */
export type PaymentStatus = "swapped" | "paid";

export interface Payment {
  billId: string;
  period: string;
  recipientId: string;
  recipient: Address;
  amountNgn: number;
  /** Atomic USD₮ that left the agent wallet for the swap, Textile fee included. */
  usdtSpent: string;
  /** Atomic USD₮ protocol fee, already inside usdtSpent. */
  usdtFee: string;
  /** Atomic cNGN received from the swap and sent on. */
  cngnAmount: string;
  /** Naira per USD₮ actually paid, fee included. */
  rate: number;
  /** Official naira per US dollar at quote time, when available. */
  referenceRate: number | null;
  rfqId: string;
  txs: { approve?: Hash; swap: Hash; transfer?: Hash };
  /** When the swap and the transfer were broadcast. A transaction still unseen long after this never landed. */
  sentAt?: { swap?: string; transfer?: string };
  /** The transfer's nonce. A resend reuses it, so the old and new transfer can never both land. */
  transferNonce?: number;
  /** Earlier transfers sent with that nonce. Any of them may still be the one that lands. */
  earlierTransfers?: Hash[];
  status: PaymentStatus;
  createdAt: string;
  updatedAt: string;
}

/** Something the agent decided not to do, and why. Published alongside payments. */
export interface Decision {
  at: string;
  billId: string;
  period: string;
  action: "skipped" | "failed";
  reason: string;
}

export interface Ledger {
  version: 1;
  agent: Address | null;
  payments: Payment[];
  decisions: Decision[];
  /** The wallet's transaction count after the agent's latest transaction. A chain ahead of this means the ledger is stale. */
  lastNonce?: number;
}

export const emptyLedger = (): Ledger => ({ version: 1, agent: null, payments: [], decisions: [] });

export async function loadLedger(path: string): Promise<Ledger> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Ledger;
    if (parsed?.version !== 1) throw new Error(`unsupported ledger version ${parsed?.version}`);
    // Every later step trusts this shape, so a hand-edited or truncated file stops here.
    if (!Array.isArray(parsed.payments) || !Array.isArray(parsed.decisions)
      || parsed.payments.some((p) => typeof p?.billId !== "string" || typeof p.txs?.swap !== "string")) {
      throw new Error(`${path} is not a valid ledger: payments and decisions must be lists, and every payment needs a billId and a swap hash`);
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyLedger();
    throw err;
  }
}

/** Write atomically: a half-written ledger would be worse than a stale one. */
export async function saveLedger(path: string, ledger: Ledger): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(ledger, null, 2) + "\n");
  await rename(tmp, path);
}

export function findPayment(ledger: Ledger, billId: string, period: string): Payment | undefined {
  return ledger.payments.find((p) => p.billId === billId && p.period === period);
}

export const isSettled = (ledger: Ledger) => (billId: string, period: string) =>
  findPayment(ledger, billId, period)?.status === "paid";

/** USD₮ (atomic) already committed this Lagos month, counting payments that are mid-flight. */
export function usdtSpentInMonth(ledger: Ledger, now: Date): bigint {
  const month = lagosMonth(now);
  return ledger.payments
    .filter((p) => lagosMonth(new Date(p.createdAt)) === month)
    .reduce((sum, p) => sum + BigInt(p.usdtSpent), 0n);
}

export function recordDecision(ledger: Ledger, d: Omit<Decision, "at">, now: Date): void {
  ledger.decisions.push({ at: now.toISOString(), ...d });
  // Keep the public log readable: one entry per bill, period and reason is enough.
  const seen = new Set<string>();
  ledger.decisions = ledger.decisions
    .reverse()
    .filter((x) => {
      const k = `${x.billId}|${x.period}|${x.action}|${x.reason}`;
      return seen.has(k) ? false : (seen.add(k), true);
    })
    .reverse();
}

/**
 * Combine two copies of the ledger that changed apart, such as two runs that saved at once.
 * Nothing either copy recorded is lost. A purchase is identified by its swap hash; when both
 * copies hold it, the one further along wins (paid over bought, a recorded transfer over none),
 * then the one saved later. Every transfer either copy sent is kept, so none can be forgotten.
 */
export function mergeLedgers(a: Ledger, b: Ledger): Ledger {
  const progress = (p: Payment) => (p.status === "paid" ? 2 : p.txs.transfer ? 1 : 0);
  const ahead = (p: Payment, q: Payment) => progress(p) - progress(q) || p.updatedAt.localeCompare(q.updatedAt);
  const payments = new Map<string, Payment>();
  for (const p of [...a.payments, ...b.payments]) {
    const seen = payments.get(p.txs.swap);
    if (!seen) { payments.set(p.txs.swap, p); continue; }
    const [win, lose] = ahead(p, seen) > 0 ? [p, seen] : [seen, p];
    const sent = [...(win.earlierTransfers ?? []), ...(lose.earlierTransfers ?? []), ...(lose.txs.transfer ? [lose.txs.transfer] : [])]
      .filter((h, i, all) => h !== win.txs.transfer && all.indexOf(h) === i);
    payments.set(p.txs.swap, sent.length ? { ...win, earlierTransfers: sent } : win);
  }
  const decisions = new Map<string, Decision>();
  for (const d of [...a.decisions, ...b.decisions]) decisions.set(`${d.at}|${d.billId}|${d.period}|${d.reason}`, d);
  return {
    version: 1,
    agent: a.agent ?? b.agent,
    ...(a.lastNonce !== undefined || b.lastNonce !== undefined ? { lastNonce: Math.max(a.lastNonce ?? 0, b.lastNonce ?? 0) } : {}),
    payments: [...payments.values()].sort((x, y) => x.createdAt.localeCompare(y.createdAt)),
    decisions: [...decisions.values()].sort((x, y) => x.at.localeCompare(y.at)),
  };
}
