import { describe, expect, it } from "vitest";
import { emptyLedger, mergeLedgers, type Ledger } from "../../src/ledger.js";
import { payBill, type PayDeps } from "../../src/payout.js";
import type { ChainOps } from "../../src/chain.js";
import type { QuoteResult } from "../../src/textile.js";
import { fakeChain, firmQuote, household, MUM } from "../fixtures.js";

const NGN = (n: number) => BigInt(n) * 10n ** 6n;
const h = household();
const light = h.bills.find((b) => b.id === "light")!;
const T0 = new Date("2026-12-05T10:00:00Z").getTime();
class Crash extends Error {}

const paidToMum = (c: ReturnType<typeof fakeChain>) =>
  c.writes.filter((w) => w.op === "transfer" && w.args[0] === MUM).reduce((s, w) => s + (w.args[1] as bigint), 0n);
const swaps = (c: ReturnType<typeof fakeChain>) => c.writes.filter((w) => w.op === "swap").length;

/** One "process": dies at its k-th effectful step. Disk = last persisted JSON. */
async function runProcess(chain: ReturnType<typeof fakeChain>, disk: { json: string }, nowMs: number, killAt: number) {
  let step = 0, dead = false;
  const tick = () => { if (dead) throw new Crash("dead"); if (++step === killAt) { dead = true; throw new Crash("killed"); } };
  const ledger: Ledger = JSON.parse(disk.json);
  const wrap = <T extends (...a: any[]) => any>(f: T) => (async (...a: any[]) => { tick(); return f(...a); }) as unknown as T;
  const wrapSent = (cb?: (h: any, n: number) => Promise<void>) => cb && (async (hh: any, n: number) => { await cb(hh, n); tick(); });
  const c: ChainOps = {
    agent: chain.agent,
    decimals: wrap(chain.decimals), balance: wrap(chain.balance), allowance: wrap(chain.allowance),
    nonceUsed: wrap(chain.nonceUsed), sentCount: wrap(chain.sentCount), receiptOf: wrap(chain.receiptOf),
    approve: async (t, s, a, cb) => { tick(); return chain.approve(t, s, a, wrapSent(cb)); },
    send: async (tx, cb) => { tick(); return chain.send(tx, wrapSent(cb)); },
    transfer: async (t, to, a, cb, n) => { tick(); return chain.transfer(t, to, a, wrapSent(cb), n); },
  };
  const quotes: QuoteResult[] = [{ status: "quoted", firm: firmQuote(2000, 1.4, nowMs) }];
  const d: PayDeps = {
    chain: c, ledger, now: () => new Date(nowMs), sleep: async () => {},
    textile: { requestQuote: wrap(async () => quotes.shift() ?? { status: "no_quote", reason: "x" }), cancel: wrap(async () => {}), submit: wrap(async () => {}) },
    reference: wrap(async () => ({ rate: 1450, sources: [] })),
    persist: async () => { if (dead) throw new Crash("dead"); disk.json = JSON.stringify(ledger); tick(); },
  };
  try { return await payBill(light, h, d); } catch (e) { if (e instanceof Crash) return { kind: "crashed" as const }; throw e; }
}

describe("crash at every step boundary, then rerun", () => {
  for (let k = 1; k <= 30; k++) {
    for (const mode of ["clean", "minedButUnconfirmed-swap", "minedButUnconfirmed-transfer", "stuck-transfer"] as const) {
      it(`kill at step ${k} (${mode}) never pays twice and eventually pays once`, async () => {
        const chain = fakeChain({ usdt: 50_000000n, swapDelivers: NGN(2000) });
        if (mode === "minedButUnconfirmed-swap") chain.minedButUnconfirmed.add("swap");
        if (mode === "minedButUnconfirmed-transfer") chain.minedButUnconfirmed.add("transfer");
        if (mode === "stuck-transfer") chain.stuck.add("transfer");
        const disk = { json: JSON.stringify({ ...emptyLedger(), agent: chain.agent }) };
        await runProcess(chain, disk, T0, k);
        for (const [i, dt] of [1, 31, 62, 93, 124, 155].entries()) {
          if (i === 2) chain.release();
          await runProcess(chain, disk, T0 + dt * 60_000, Infinity);
          expect(paidToMum(chain)).toBeLessThanOrEqual(NGN(2000));
        }
        expect(paidToMum(chain)).toBe(NGN(2000));
        expect(swaps(chain)).toBe(1);
      });
    }
  }
});

describe("two writers", () => {
  it("two runs at the same moment with separate ledgers pay once (their nonces collide)", async () => {
    const chain = fakeChain({ usdt: 50_000000n, swapDelivers: NGN(2000) });
    const a = { json: JSON.stringify({ ...emptyLedger(), agent: chain.agent }) };
    const b = { json: a.json };
    await Promise.all([runProcess(chain, a, T0, Infinity), runProcess(chain, b, T0, Infinity)]);
    expect(paidToMum(chain)).toBe(NGN(2000)); // same-nonce collision saves the fake; staggered is the real risk
  });

  it("a run that starts from a stale ledger (lost save, local run) refuses to buy", async () => {
    const chain = fakeChain({ usdt: 50_000000n, swapDelivers: NGN(2000) });
    await runProcess(chain, { json: JSON.stringify({ ...emptyLedger(), agent: chain.agent }) }, T0, Infinity); // sets lastNonce
    // An older copy that knows the agent has sent before, but not this payment.
    const stale = JSON.stringify({ ...emptyLedger(), agent: chain.agent, lastNonce: 0 });
    expect(await runProcess(chain, { json: stale }, T0 + 60_000, Infinity)).toMatchObject({ kind: "failed", reason: expect.stringContaining("does not record") });
    expect(paidToMum(chain)).toBe(NGN(2000));
  });

  it("merging two copies at the same progress keeps every transfer sent, so a landed resend is never paid again", async () => {
    // Process A: transfer X stuck. Snapshot = "upstream" copy.
    const chain = fakeChain({ usdt: 50_000000n, swapDelivers: NGN(2000) });
    chain.drops.add("transfer");
    const disk = { json: JSON.stringify({ ...emptyLedger(), agent: chain.agent }) };
    await runProcess(chain, disk, T0, Infinity);
    const upstream: Ledger = JSON.parse(disk.json);
    // 31 min later, a run resends Y on the same nonce; Y also stuck-pending at save time.
    chain.stuck.add("transfer");
    await runProcess(chain, disk, T0 + 31 * 60_000, Infinity);
    const mine: Ledger = JSON.parse(disk.json);
    expect(mine.payments[0]!.earlierTransfers?.length).toBe(1);
    const merged = mergeLedgers(upstream, mine); // workflow order: upstream first, mine second
    expect(merged.payments[0]!.earlierTransfers).toHaveLength(1); // the first transfer is kept
    disk.json = JSON.stringify(merged);
    chain.release(); // Y (nonce n) lands; X can no longer land
    expect(paidToMum(chain)).toBe(NGN(2000));
    chain.state.cngn += NGN(3000); // another bill's naira, bought and awaiting delivery
    expect(await runProcess(chain, disk, T0 + 70 * 60_000, Infinity)).toMatchObject({ kind: "paid" });
    expect(paidToMum(chain)).toBe(NGN(2000));
  });
});
