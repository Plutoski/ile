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
    const transfer = chain.transfer;
    chain.transfer = async () => { throw new Error("RPC timed out"); };
    const { d, ledger, textile } = deps(chain, [{ status: "quoted", firm: firmQuote(2000, 1.4, NOW.getTime()) }]);

    expect((await payBill(light, h, d)).kind).toBe("failed");
    expect(ledger.payments[0]!.status).toBe("swapped");

    chain.transfer = transfer;
    const out = await payBill(light, h, d);
    expect(out.kind).toBe("paid");
    expect(chain.writes.map((w) => w.op)).toEqual(["approve", "swap", "transfer"]);
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

  it("records a short swap and never buys again for it", async () => {
    const chain = fakeChain({ usdt: 5_000000n, swapDelivers: NGN(1999) });
    const quotes = () => [{ status: "quoted" as const, firm: firmQuote(2000, 1.4, NOW.getTime()) }];
    const { d, ledger, textile } = deps(chain, [...quotes(), ...quotes()]);
    expect(await payBill(light, h, d)).toMatchObject({ kind: "failed", reason: expect.stringContaining("delivered") });
    expect(await payBill(light, h, d)).toMatchObject({ kind: "failed", reason: expect.stringContaining("delivered") });
    expect(chain.writes.map((w) => w.op)).toEqual(["approve", "swap"]);
    expect(textile.requestQuote).toHaveBeenCalledOnce();
    expect(ledger.payments[0]).toMatchObject({ status: "swapped", txs: { swap: expect.any(String) } });
  });
});

describe("never buying or paying twice when the chain answers late", () => {
  const quote = () => ({ status: "quoted" as const, firm: firmQuote(2000, 1.4, NOW.getTime()) });

  it("a swap that lands while its confirmation fails is recorded, and the next run only delivers", async () => {
    const chain = fakeChain({ usdt: 5_000000n, swapDelivers: NGN(2000) });
    chain.minedButUnconfirmed.add("swap");
    const { d, ledger, textile } = deps(chain, [quote(), quote()]);

    expect((await payBill(light, h, d)).kind).toBe("failed");
    expect(ledger.payments[0]).toMatchObject({ status: "swapped", txs: { swap: expect.any(String) } });

    expect((await payBill(light, h, d)).kind).toBe("paid");
    expect(chain.writes.map((w) => w.op)).toEqual(["approve", "swap", "transfer"]);
    expect(textile.requestQuote).toHaveBeenCalledOnce();
  });

  it("a transfer that lands while its confirmation fails is not sent again", async () => {
    const chain = fakeChain({ usdt: 5_000000n, swapDelivers: NGN(2000) });
    chain.minedButUnconfirmed.add("transfer");
    const { d, ledger } = deps(chain, [quote()]);

    expect((await payBill(light, h, d)).kind).toBe("failed");
    chain.state.cngn += NGN(5000); // naira from elsewhere sits in the wallet, enough to pay again by mistake
    expect((await payBill(light, h, d)).kind).toBe("paid");
    expect(chain.writes.filter((w) => w.op === "transfer")).toHaveLength(1);
    expect(ledger.payments[0]!.status).toBe("paid");
  });

  it("a swap that reverted is dropped, so the bill is bought fresh", async () => {
    const chain = fakeChain({ usdt: 5_000000n, swapDelivers: NGN(2000) });
    chain.reverts.add("swap");
    const { d, ledger } = deps(chain, [quote(), quote()]);

    expect((await payBill(light, h, d)).kind).toBe("failed");
    expect((await payBill(light, h, d)).kind).toBe("failed"); // the resume sees the revert and drops the record
    expect(ledger.payments).toEqual([]);
    expect((await payBill(light, h, d)).kind).toBe("paid");
    expect(chain.writes.filter((w) => w.op === "swap")).toHaveLength(1);
  });

  it("a swap the network dropped is bought fresh only after 30 minutes without a receipt", async () => {
    const chain = fakeChain({ usdt: 5_000000n, swapDelivers: NGN(2000) });
    chain.drops.add("swap");
    let clock = NOW.getTime();
    const later = { status: "quoted" as const, firm: firmQuote(2000, 1.4, NOW.getTime() + 35 * 60_000) };
    const { d, ledger } = deps(chain, [quote(), later]);
    d.now = () => new Date(clock);

    expect((await payBill(light, h, d)).kind).toBe("failed");
    clock += 5 * 60_000;
    expect(await payBill(light, h, d)).toMatchObject({ kind: "failed", reason: expect.stringContaining("not on chain yet") });
    expect(ledger.payments).toHaveLength(1);
    clock += 30 * 60_000;
    expect(await payBill(light, h, d)).toMatchObject({ kind: "failed", reason: expect.stringContaining("never landed") });
    expect(ledger.payments).toEqual([]);
    expect((await payBill(light, h, d)).kind).toBe("paid");
  });

  it("a transfer the network dropped is sent again only after 30 minutes without a receipt", async () => {
    const chain = fakeChain({ usdt: 5_000000n, swapDelivers: NGN(2000) });
    chain.drops.add("transfer");
    let clock = NOW.getTime();
    const { d } = deps(chain, [quote()]);
    d.now = () => new Date(clock);

    expect((await payBill(light, h, d)).kind).toBe("failed");
    expect(await payBill(light, h, d)).toMatchObject({ kind: "failed", reason: expect.stringContaining("not on chain yet") });
    clock += 31 * 60_000;
    expect((await payBill(light, h, d)).kind).toBe("paid");
    expect(chain.writes.filter((w) => w.op === "transfer")).toHaveLength(1); // the dropped one never landed
  });

  it("a stuck transfer that lands late cannot pay the bill twice: the resend takes its nonce", async () => {
    const chain = fakeChain({ usdt: 5_000000n, swapDelivers: NGN(4000) });
    chain.stuck.add("transfer");
    let clock = NOW.getTime();
    const { d } = deps(chain, [quote()]);
    d.now = () => new Date(clock);

    expect((await payBill(light, h, d)).kind).toBe("failed");
    clock += 31 * 60_000;
    expect((await payBill(light, h, d)).kind).toBe("paid"); // resent with the stuck transfer's nonce
    chain.release(); // the stuck transfer finally reaches a block, but its nonce is gone
    expect(chain.writes.filter((w) => w.op === "transfer")).toHaveLength(1);
    expect(chain.state.cngn).toBe(NGN(2000));
  });

  it("a dropped transfer whose nonce another payment has since used is sent fresh", async () => {
    const fees = h.bills.find((b) => b.id === "fees")!;
    const chain = fakeChain({ usdt: 10_000000n, swapDelivers: NGN(2000) });
    chain.drops.add("transfer");
    let clock = NOW.getTime();
    const feesQuote = { status: "quoted" as const, firm: firmQuote(3000, 2.1, NOW.getTime()) };
    const { d } = deps(chain, [quote(), feesQuote]);
    d.now = () => new Date(clock);

    expect((await payBill(light, h, d)).kind).toBe("failed");
    chain.nextSwapDelivers = NGN(3000);
    expect((await payBill(fees, h, d)).kind).toBe("paid"); // takes the dropped transfer's nonce
    clock += 31 * 60_000;
    expect((await payBill(light, h, d)).kind).toBe("paid");
    expect(chain.writes.filter((w) => w.op === "transfer")).toHaveLength(2);
  });

  it("if the resend is refused and the stuck transfer lands after all, that transfer pays the bill", async () => {
    const chain = fakeChain({ usdt: 5_000000n, swapDelivers: NGN(4000) });
    chain.stuck.add("transfer");
    let clock = NOW.getTime();
    const { d, ledger } = deps(chain, [quote()]);
    d.now = () => new Date(clock);

    expect((await payBill(light, h, d)).kind).toBe("failed");
    clock += 31 * 60_000;
    chain.drops.add("transfer"); // the node refuses the resend
    expect((await payBill(light, h, d)).kind).toBe("failed");
    chain.release(); // the first transfer lands
    clock += 31 * 60_000;
    expect((await payBill(light, h, d)).kind).toBe("paid");
    expect(chain.writes.filter((w) => w.op === "transfer")).toHaveLength(1);
    expect(ledger.payments[0]!.txs.transfer).toBe(ledger.payments[0]!.earlierTransfers![0]);
  });

  it("a transfer that landed counts as paid even if the household file changed the address since", async () => {
    const chain = fakeChain({ usdt: 5_000000n, swapDelivers: NGN(2000) });
    chain.minedButUnconfirmed.add("transfer");
    const { d, ledger } = deps(chain, [quote()]);
    expect((await payBill(light, h, d)).kind).toBe("failed");

    const moved = { ...h, recipients: [{ ...h.recipients[0]!, address: "0x2222222222222222222222222222222222222222" as const }] };
    expect((await payBill(light, moved, d)).kind).toBe("paid");
    expect(ledger.payments[0]!.status).toBe("paid");
  });

  it("does not mistake naira bought for another bill, still awaiting delivery, for an unrecorded swap", async () => {
    const fees = h.bills.find((b) => b.id === "fees")!;
    const chain = fakeChain({ usdt: 10_000000n, swapDelivers: NGN(3000) });
    const transfer = chain.transfer;
    chain.transfer = async () => { throw new Error("RPC timed out"); }; // fees is bought, its delivery fails
    const feesQuote = { status: "quoted" as const, firm: firmQuote(3000, 2.1, NOW.getTime()) };
    const { d } = deps(chain, [feesQuote, quote()]);
    expect((await payBill(fees, h, d)).kind).toBe("failed"); // 3000 cNGN now sits in the wallet, owed to fees

    chain.transfer = transfer;
    chain.nextSwapDelivers = NGN(2000);
    expect((await payBill(light, h, d)).kind).toBe("paid"); // the 3000 is explained, so light is bought normally
  });

  it("refuses to buy when the wallet already holds naira the ledger cannot explain", async () => {
    const chain = fakeChain({ usdt: 5_000000n, cngn: NGN(2000), swapDelivers: NGN(2000) });
    const { d, textile } = deps(chain, [quote()]);
    expect(await payBill(light, h, d)).toMatchObject({ kind: "failed", reason: expect.stringContaining("unrecorded") });
    expect(chain.writes).toEqual([]);
    expect(textile.requestQuote).not.toHaveBeenCalled();
  });

  it("delivers to the address recorded at purchase, and refuses if the household file changed it", async () => {
    const chain = fakeChain({ usdt: 5_000000n, swapDelivers: NGN(2000) });
    const transfer = chain.transfer;
    chain.transfer = async () => { throw new Error("RPC timed out"); };
    const { d } = deps(chain, [quote()]);
    expect((await payBill(light, h, d)).kind).toBe("failed");

    chain.transfer = transfer;
    const moved = { ...h, recipients: [{ ...h.recipients[0]!, address: "0x2222222222222222222222222222222222222222" as const }] };
    expect(await payBill(light, moved, d)).toMatchObject({ kind: "failed", reason: expect.stringContaining("address") });
    expect(chain.writes.filter((w) => w.op === "transfer")).toHaveLength(0);
  });
});
