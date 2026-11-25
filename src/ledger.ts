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
}

export const emptyLedger = (): Ledger => ({ version: 1, agent: null, payments: [], decisions: [] });

export async function loadLedger(path: string): Promise<Ledger> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Ledger;
    if (parsed.version !== 1) throw new Error(`unsupported ledger version ${parsed.version}`);
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
