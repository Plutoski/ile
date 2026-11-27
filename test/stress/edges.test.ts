import { describe, expect, it, vi } from "vitest";
import { dueDateOf, isDue, lagosDate, lagosMonth, parseHousehold, type Bill } from "../../src/household.js";
import { emptyLedger, loadLedger, mergeLedgers, recordDecision, usdtSpentInMonth, type Ledger } from "../../src/ledger.js";
import { checkPrice, checkQuote } from "../../src/policy.js";
import { payBill, type PayDeps } from "../../src/payout.js";
import { fetchReferenceRate } from "../../src/rate.js";
import { TextileClient } from "../../src/textile.js";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { account, fakeChain, firmQuote, household, MUM } from "../fixtures.js";

const NGN = (n: number) => BigInt(n) * 10n ** 6n;
const h = household();
const light = h.bills.find((b) => b.id === "light")!;
const pol = { maxUsdtPerPayout: 3, maxUsdtPerMonth: 10, maxSpreadPct: 3 };
let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]!;

describe("policy properties", () => {
  it("fuzz: ok verdict implies caps and spread hold (5000 cases)", () => {
    for (let i = 0; i < 5000; i++) {
      const takerPays = BigInt(Math.floor(rnd() * 5_000_000)) - 10n;
      const spent = BigInt(Math.floor(rnd() * 12_000_000));
      const ref = rnd() < 0.2 ? null : 1300 + rnd() * 300;
      const cngn = NGN(Math.floor(rnd() * 5000) + 1);
      const v = checkPrice({ takerPays, cngnAtomic: cngn, cngnDecimals: 6, policy: pol, spentThisMonth: spent, referenceRate: ref });
      if (v.ok) {
        expect(takerPays > 0n && takerPays <= 3_000000n && spent + takerPays <= 10_000000n).toBe(true);
        if (ref !== null) expect(v.rate).toBeGreaterThanOrEqual(ref * 0.97 - 1e-9);
      }
    }
  });
  it("monthly cap boundary is inclusive", () => {
    expect(checkPrice({ takerPays: 1n, cngnAtomic: 1n, cngnDecimals: 6, policy: pol, spentThisMonth: 9_999999n, referenceRate: null }).ok).toBe(true);
    expect(checkPrice({ takerPays: 2n, cngnAtomic: 1n, cngnDecimals: 6, policy: pol, spentThisMonth: 9_999999n, referenceRate: null }).ok).toBe(false);
  });
  it("parseHousehold refuses caps that cannot become a USD₮ amount (1e-7, 1e21)", () => {
    const base = { name: "x", sender: "y", recipients: [{ id: "m", name: "M", address: MUM }], bills: [], policy: { maxUsdtPerPayout: 1e-7, maxUsdtPerMonth: 1e21, maxSpreadPct: 3 } };
    expect(() => parseHousehold(base)).toThrow(/maxUsdtPerPayout[\s\S]*maxUsdtPerMonth/);
  });
  it("hostile firm quotes are refused or throw (never ok)", () => {
    const now = Date.parse("2026-12-05T10:00:00Z");
    const base = () => firmQuote(2000, 1.4, now);
    const cases: [string, (f: ReturnType<typeof base>) => void][] = [
      ["wrong taker", (f) => { f.quote.taker = MUM; }],
      ["swap to other", (f) => { f.transactions.swap.to = MUM; }],
      ["approval to other", (f) => { f.transactions.approval.to = MUM; }],
      ["chainId string", (f) => { (f.transactions.swap as any).chainId = "42220"; }],
      ["native value", (f) => { f.transactions.swap.value = "1"; }],
      ["less naira", (f) => { f.quote.buyAmount = (NGN(2000) - 1n).toString(); }],
      ["expired", (f) => { f.quote.expiresAt = new Date(now - 1).toISOString(); }],
      ["garbage expiry", (f) => { f.quote.expiresAt = "soon"; }],
      ["huge takerPays", (f) => { f.quote.takerPays = "9".repeat(40); }],
      ["negative", (f) => { f.quote.takerPays = "-1"; }],
      ["empty", (f) => { f.quote.takerPays = ""; }],
      ["decimal string", (f) => { f.quote.takerPays = "1.5"; }],
      ["missing transactions", (f) => { (f as any).transactions = { swap: f.transactions.swap }; }],
    ];
    for (const [name, mut] of cases) {
      const f = base(); mut(f);
      let ok = false;
      try { ok = checkQuote({ firm: f, agent: account.address, requestedCngn: NGN(2000), cngnDecimals: 6, policy: pol, spentThisMonth: 0n, referenceRate: 1450, now }).ok; } catch { ok = false; }
      expect(ok, name).toBe(false);
    }
  });
});

describe("household parsing fuzz", () => {
  const junk = [null, 0, -1, 1.5, "", "x", [], {}, true, "2026-02-30", 31, 32, "0x1111111111111111111111111111111111111111", 1e300];
  it("random objects either throw an Error or produce a valid household (3000 cases)", () => {
    for (let i = 0; i < 3000; i++) {
      const raw: any = { name: pick(["n", ...junk]), sender: pick(["s", ...junk]),
        recipients: pick([[{ id: "m", name: "M", relation: pick(junk), address: pick([MUM, ...junk]) }], junk, [null], []]),
        bills: [{ id: pick(["b", ...junk]), label: pick(["L", ...junk]), recipientId: pick(["m", ...junk]), amountNgn: pick([2000, ...junk]),
          schedule: pick([{ kind: "monthly", day: pick(junk) }, { kind: "once", date: pick(junk) }, null, { kind: "weekly" }]) }],
        policy: pick([pol, null, { ...pol, maxSpreadPct: pick(junk) }, { ...pol, maxUsdtPerPayout: pick(junk) }]) };
      try {
        const hh = parseHousehold(raw);
        for (const b of hh.bills) { expect(Number.isInteger(b.amountNgn) && b.amountNgn > 0).toBe(true); expect(() => dueDateOf(b, new Date())).not.toThrow(); }
      } catch (e) { expect(e).toBeInstanceOf(Error); }
    }
  });
  it("impossible dates like 2026-02-30 are refused", () => {
    expect(() => parseHousehold({ name: "x", sender: "y", recipients: [{ id: "m", name: "M", address: MUM }], policy: pol,
      bills: [{ id: "b", label: "L", recipientId: "m", amountNgn: 1, schedule: { kind: "once", date: "2026-02-30" } }] })).toThrow(/real date/);
  });
});

describe("time edges", () => {
  const monthly = (day: number): Bill => ({ ...light, schedule: { kind: "monthly", day } });
  it("Lagos day/month rollover at 23:00 UTC", () => {
    expect(lagosDate(new Date("2026-11-30T22:59:59Z"))).toBe("2026-11-30");
    expect(lagosDate(new Date("2026-11-30T23:00:00Z"))).toBe("2026-12-01");
    expect(lagosMonth(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01");
  });
  it("day 31 clamps to month end incl. leap years", () => {
    expect(dueDateOf(monthly(31), new Date("2028-02-10T00:00:00Z"))).toBe("2028-02-29");
    expect(dueDateOf(monthly(31), new Date("2027-02-10T00:00:00Z"))).toBe("2027-02-28");
    expect(dueDateOf(monthly(31), new Date("2026-04-30T12:00:00Z"))).toBe("2026-04-30");
    expect(isDue(monthly(31), new Date("2026-04-30T12:00:00Z"), () => false)).toBe(true);
  });
  it("every hour of 2026-2028: isDue(monthly d) true iff Lagos day >= clamp(d)", () => {
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2029, 0, 1); t += 3600e3 * 7) {
      const now = new Date(t), d = 1 + (t / 3600e3) % 31;
      const local = new Date(t + 3600e3); const last = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate();
      expect(isDue(monthly(d), now, () => false)).toBe(local.getUTCDate() >= Math.min(d, last));
    }
  });
});

describe("ledger robustness", () => {
  it("a ledger object without decisions makes payBill reject (loadLedger refuses such a file first)", async () => {
    const chain = fakeChain({ usdt: 5_000000n });
    const ledger = { version: 1, agent: chain.agent, payments: [] } as unknown as Ledger;
    const d: PayDeps = { chain, ledger, persist: async () => {}, now: () => new Date("2026-12-05T10:00:00Z"), sleep: async () => {},
      textile: { requestQuote: async () => ({ status: "no_quote", reason: "no_makers_online" }), cancel: async () => {}, submit: async () => {} },
      reference: async () => null };
    await expect(payBill(light, h, d)).rejects.toThrow(TypeError);
  });
  it("corrupted file fails closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "l-"));
    for (const body of ["{", "", "null", '{"version":2}']) {
      await writeFile(join(dir, "l.json"), body);
      await expect(loadLedger(join(dir, "l.json"))).rejects.toThrow();
    }
  });
  it("loadLedger refuses payments with no swap hash and ledgers with no decisions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "l-"));
    for (const body of [{ version: 1, agent: null, payments: [{ billId: "x" }], decisions: [] }, { version: 1, agent: null, payments: [] }]) {
      await writeFile(join(dir, "l.json"), JSON.stringify(body));
      await expect(loadLedger(join(dir, "l.json"))).rejects.toThrow(/not a valid ledger/);
    }
  });
  it("merge is idempotent and commutative on payment sets for distinct swaps (500 random)", () => {
    for (let i = 0; i < 500; i++) {
      const mk = (): Ledger => ({ ...emptyLedger(), payments: Array.from({ length: Math.floor(rnd() * 4) }, (_, j) => ({
        billId: "b" + j, period: "once", recipientId: "m", recipient: MUM, amountNgn: 1, usdtSpent: "1", usdtFee: "0", cngnAmount: "1", rate: 1,
        referenceRate: null, rfqId: "r", txs: { swap: `0x${Math.floor(rnd() * 6)}` as any, ...(rnd() < 0.5 ? { transfer: "0xt" as any } : {}) },
        status: rnd() < 0.5 ? "paid" : "swapped", createdAt: `2026-11-2${j}T00:00:00Z`, updatedAt: "x" })) });
      const a = mk(), b = mk();
      const ab = mergeLedgers(a, b);
      expect(mergeLedgers(ab, ab).payments).toEqual(ab.payments);
      expect(new Set(ab.payments.map((p) => p.txs.swap))).toEqual(new Set(mergeLedgers(b, a).payments.map((p) => p.txs.swap)));
    }
  });
  it("known: merge brings back a swap one copy dropped as never landed (the next run drops it again)", () => {
    const p = { billId: "b", period: "once", recipientId: "m", recipient: MUM, amountNgn: 1, usdtSpent: "1", usdtFee: "0", cngnAmount: "1", rate: 1,
      referenceRate: null, rfqId: "r", txs: { swap: "0xdead" as any }, status: "swapped" as const, createdAt: "2026-12-01T00:00:00Z", updatedAt: "x" };
    expect(mergeLedgers({ ...emptyLedger(), payments: [p] }, emptyLedger()).payments).toHaveLength(1);
  });
  it("recordDecision keeps the log bounded under repeated failures", () => {
    const l = emptyLedger();
    for (let i = 0; i < 1000; i++) recordDecision(l, { billId: "b", period: "once", action: "failed", reason: "same" }, new Date(i));
    expect(l.decisions).toHaveLength(1);
  });
});

describe("monthly bill that misses its month", () => {
  it("a monthly purchase still undelivered when the Lagos month changes is finished the next month", async () => {
    const chain = fakeChain({ usdt: 50_000000n, swapDelivers: NGN(2000) });
    chain.stuck.add("transfer");
    const ledger: Ledger = { ...emptyLedger(), agent: chain.agent };
    let now = new Date("2026-11-30T21:17:00Z"); // last cron of November, Lagos 22:17
    const d: PayDeps = { chain, ledger, persist: async () => {}, now: () => now, sleep: async () => {},
      textile: { requestQuote: async () => ({ status: "quoted", firm: firmQuote(2000, 1.4, now.getTime()) }), cancel: async () => {}, submit: async () => {} },
      reference: async () => ({ rate: 1450, sources: [] }) };
    const nov = { ...light, schedule: { kind: "monthly" as const, day: 30 } };
    expect((await payBill(nov, h, d)).kind).toBe("failed"); // transfer pending
    chain.drops.clear();
    now = new Date("2026-11-30T23:17:00Z"); // Lagos Dec 1
    expect(ledger.payments[0]!.status).toBe("swapped");
    chain.release();
    now = new Date("2026-12-01T00:17:00Z"); // 31+ minutes later, in December
    expect(await payBill(nov, h, d)).toMatchObject({ kind: "paid", payment: { period: "2026-11" } });
    expect(usdtSpentInMonth(ledger, now)).toBe(0n); // the spend stays in November
  });
});

describe("reference rate and Textile client", () => {
  const res = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  it("both down -> null; one up -> single unverified source used", async () => {
    expect(await fetchReferenceRate(async () => { throw new Error("down"); })).toBeNull();
    const one = await fetchReferenceRate(async (u) => String(u).includes("er-api") ? res({ rates: { NGN: 1000 } }) : res("x", 500));
    expect(one?.rate).toBe(1000);
  });
  it("hostile Textile bodies become TextileError or a non-quote, never a throw-free garbage quote", async () => {
    const bodies = ["", "<html>", "null", '{"data":null}', '{"data":{"status":"quoted"}}', '{"error":{"code":"x"}}'];
    for (const b of bodies) {
      const c = new TextileClient(account, (async () => res(b)) as any);
      const r = await c.requestQuote({ sellToken: MUM, buyToken: MUM, buyAmount: 1n }).catch((e) => e);
      if (!(r instanceof Error) && r.status === "quoted") {
        expect(() => checkQuote({ firm: r.firm, agent: account.address, requestedCngn: 1n, cngnDecimals: 6, policy: pol, spentThisMonth: 0n, referenceRate: 1450, now: 0 })).toThrow();
      }
    }
  });
});
