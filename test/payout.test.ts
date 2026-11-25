import { describe, expect, it, vi } from "vitest";
import { emptyLedger, type Ledger } from "../src/ledger.js";
import { payBill, type PayDeps } from "../src/payout.js";
import type { QuoteResult } from "../src/textile.js";
import { fakeChain, firmQuote, household, MUM } from "./fixtures.js";

const NOW = new Date("2026-12-05T10:00:00Z");
const NGN = (n: number) => BigInt(n) * 10n ** 6n;
const h = household();
const light = h.bills.find((b) => b.id === "light")!;

function deps(chain: ReturnType<typeof fakeChain>, quotes: QuoteResult[], over: Partial<PayDeps> = {}) {
  const ledger: Ledger = { ...emptyLedger(), agent: chain.agent };
  const textile = {
    requestQuote: vi.fn(async () => quotes.shift() ?? { status: "no_quote" as const, reason: "no_valid_quote" }),
    cancel: vi.fn(async () => {}),
    submit: vi.fn(async () => {}),
  };
  const persist = vi.fn(async () => {});
  return {
    ledger, textile, persist,
    d: { chain, textile, ledger, persist, reference: async () => ({ rate: 1450, sources: [] }), now: () => NOW, sleep: async () => {}, ...over } satisfies PayDeps,
  };
}

describe("paying a bill", () => {
  it("swaps USD₮ for the exact naira and sends it to the recipient", async () => {
    const chain = fakeChain({ usdt: 5_000000n, swapDelivers: NGN(2000) });
    const { d, ledger } = deps(chain, [{ status: "quoted", firm: firmQuote(2000, 1.4, NOW.getTime()) }]);

    const out = await payBill(light, h, d);

    expect(out.kind).toBe("paid");
    expect(chain.writes.map((w) => w.op)).toEqual(["approve", "swap", "transfer"]);
    expect(chain.writes[0]!.args).toEqual([1_400000n]); // exact amount, never unlimited
    expect(chain.writes[2]!.args).toEqual([MUM, NGN(2000)]);
    expect(ledger.payments[0]).toMatchObject({ billId: "light", period: "2026-12", status: "paid", usdtSpent: "1400000" });
    expect(d.textile.submit).toHaveBeenCalledOnce();
  });

  it("resets a leftover USD₮ allowance to zero before approving", async () => {
    const chain = fakeChain({ usdt: 5_000000n, allowance: 1n, swapDelivers: NGN(2000) });
    const { d } = deps(chain, [{ status: "quoted", firm: firmQuote(2000, 1.4, NOW.getTime()) }]);
    await payBill(light, h, d);
    expect(chain.writes.slice(0, 2).map((w) => w.args[0])).toEqual([0n, 1_400000n]);
  });

  it("skips the approval when the allowance already covers the swap", async () => {
    const chain = fakeChain({ usdt: 5_000000n, allowance: 2_000000n, swapDelivers: NGN(2000) });
    const { d } = deps(chain, [{ status: "quoted", firm: firmQuote(2000, 1.4, NOW.getTime()) }]);
    await payBill(light, h, d);
    expect(chain.writes.map((w) => w.op)).toEqual(["swap", "transfer"]);
  });

  it("never pays the same bill twice in a period", async () => {
    const chain = fakeChain({ usdt: 5_000000n, swapDelivers: NGN(2000) });
    const { d, textile } = deps(chain, [{ status: "quoted", firm: firmQuote(2000, 1.4, NOW.getTime()) }]);
    await payBill(light, h, d);
    const second = await payBill(light, h, d);
    expect(second).toEqual({ kind: "skipped", reason: "already paid this period" });
    expect(textile.requestQuote).toHaveBeenCalledOnce();
  });

  it("after a crash between swap and transfer, only delivers on the next run", async () => {
    const chain = fakeChain({ usdt: 5_000000n, swapDelivers: NGN(2000) });
    chain.transfer = async () => { throw new Error("RPC timed out"); };
    const { d, ledger, textile } = deps(chain, [{ status: "quoted", firm: firmQuote(2000, 1.4, NOW.getTime()) }]);

    expect((await payBill(light, h, d)).kind).toBe("failed");
    expect(ledger.payments[0]!.status).toBe("swapped");

    const healthy = fakeChain({ usdt: 0n, cngn: NGN(2000) });
    const out = await payBill(light, h, { ...d, chain: healthy });
    expect(out.kind).toBe("paid");
    expect(healthy.writes.map((w) => w.op)).toEqual(["transfer"]);
    expect(textile.requestQuote).toHaveBeenCalledOnce(); // no second purchase
  });

  it("refuses a bad quote, releases it, and moves no money", async () => {
    const chain = fakeChain({ usdt: 5_000000n });
    const { d, ledger, textile } = deps(chain, [{ status: "quoted", firm: firmQuote(2000, 1.6, NOW.getTime()) }]);
    const out = await payBill(light, h, d);
    expect(out).toMatchObject({ kind: "skipped", reason: expect.stringContaining("below the official rate") });
    expect(chain.writes).toEqual([]);
    expect(textile.cancel).toHaveBeenCalledOnce();
    expect(ledger.decisions[0]).toMatchObject({ billId: "light", action: "skipped" });
  });

  it("skips when the wallet cannot cover the quote", async () => {
    const chain = fakeChain({ usdt: 1_000000n });
    const { d } = deps(chain, [{ status: "quoted", firm: firmQuote(2000, 1.4, NOW.getTime()) }]);
    const out = await payBill(light, h, d);
    expect(out).toMatchObject({ kind: "skipped", reason: expect.stringContaining("needs 1.4000") });
    expect(chain.writes).toEqual([]);
  });

  it("fails closed without a trustworthy reference rate", async () => {
    const chain = fakeChain({ usdt: 5_000000n });
    const { d, textile } = deps(chain, [], { reference: async () => null });
    const out = await payBill(light, h, d);
    expect(out).toMatchObject({ kind: "skipped", reason: expect.stringContaining("reference rate") });
    expect(textile.requestQuote).not.toHaveBeenCalled();
  });

  it("retries a missed quote, then pays", async () => {
    const chain = fakeChain({ usdt: 5_000000n, swapDelivers: NGN(2000) });
    const { d, textile } = deps(chain, [
      { status: "no_quote", reason: "no_valid_quote" },
      { status: "quoted", firm: firmQuote(2000, 1.4, NOW.getTime()) },
    ]);
    expect((await payBill(light, h, d)).kind).toBe("paid");
    expect(textile.requestQuote).toHaveBeenCalledTimes(2);
  });

  it("stops retrying when no maker is online", async () => {
    const chain = fakeChain({ usdt: 5_000000n });
    const { d, textile } = deps(chain, [{ status: "no_quote", reason: "no_makers_online" }]);
    const out = await payBill(light, h, d);
    expect(out).toMatchObject({ kind: "skipped", reason: expect.stringContaining("no_makers_online") });
    expect(textile.requestQuote).toHaveBeenCalledOnce();
  });

  it("does not record a payment when the swap delivers less than asked", async () => {
    const chain = fakeChain({ usdt: 5_000000n, swapDelivers: NGN(1999) });
    const { d, ledger } = deps(chain, [{ status: "quoted", firm: firmQuote(2000, 1.4, NOW.getTime()) }]);
    const out = await payBill(light, h, d);
    expect(out).toMatchObject({ kind: "failed", reason: expect.stringContaining("expected") });
    expect(ledger.payments).toEqual([]);
  });
});
