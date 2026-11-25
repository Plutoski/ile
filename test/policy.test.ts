import { describe, expect, it } from "vitest";
import { checkQuote, effectiveRate } from "../src/policy.js";
import { account, CNGN_DECIMALS, firmQuote, household } from "./fixtures.js";

const now = Date.parse("2026-12-05T10:00:00Z");
const policy = household().policy;
const base = (over: Partial<Parameters<typeof checkQuote>[0]> = {}) => ({
  firm: firmQuote(2000, 1.4, now),
  agent: account.address,
  requestedCngn: 2000n * 10n ** 6n,
  cngnDecimals: CNGN_DECIMALS,
  policy,
  spentThisMonth: 0n,
  referenceRate: 1450,
  now,
  ...over,
});

describe("quote checks", () => {
  it("accepts a fair quote and reports the rate", () => {
    const v = checkQuote(base());
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.rate).toBeCloseTo(1428.57, 1);
  });

  it("refuses a quote bound to another wallet", () => {
    const v = checkQuote(base({ firm: firmQuote(2000, 1.4, now, { taker: "0x2222222222222222222222222222222222222222" }) }));
    expect(v).toMatchObject({ ok: false, reason: expect.stringContaining("not the agent wallet") });
  });

  it("refuses any reactor other than Textile's", () => {
    const evil = "0x3333333333333333333333333333333333333333" as const;
    expect(checkQuote(base({ firm: firmQuote(2000, 1.4, now, { reactor: evil }) })).ok).toBe(false);
    const f = firmQuote(2000, 1.4, now);
    f.transactions.swap.to = evil;
    expect(checkQuote(base({ firm: f }))).toMatchObject({ ok: false, reason: expect.stringContaining("not Textile's reactor") });
  });

  it("refuses a quote that would send native CELO", () => {
    const f = firmQuote(2000, 1.4, now);
    f.transactions.swap.value = "1";
    expect(checkQuote(base({ firm: f })).ok).toBe(false);
  });

  it("refuses a quote that delivers a different amount", () => {
    expect(checkQuote(base({ requestedCngn: 2500n * 10n ** 6n })).ok).toBe(false);
  });

  it("enforces the per-bill cap", () => {
    const v = checkQuote(base({ firm: firmQuote(5000, 3.5, now), requestedCngn: 5000n * 10n ** 6n }));
    expect(v).toMatchObject({ ok: false, reason: expect.stringContaining("per-bill cap") });
  });

  it("enforces the monthly cap including what is already spent", () => {
    const v = checkQuote(base({ spentThisMonth: 9_000_000n }));
    expect(v).toMatchObject({ ok: false, reason: expect.stringContaining("monthly cap") });
  });

  it("refuses a rate too far below mid-market", () => {
    // ₦2000 for $1.50 is ₦1333/$, 8% below ₦1450
    const v = checkQuote(base({ firm: firmQuote(2000, 1.5, now) }));
    expect(v).toMatchObject({ ok: false, reason: expect.stringContaining("below mid-market") });
  });

  it("refuses a quote about to expire", () => {
    const v = checkQuote(base({ now: now + 57_000 }));
    expect(v).toMatchObject({ ok: false, reason: expect.stringContaining("expires") });
  });

  it("computes the effective rate with the fee included", () => {
    expect(effectiveRate(2000_000000n, 6, 1_400000n)).toBeCloseTo(1428.571, 2);
    expect(effectiveRate(1n, 6, 0n)).toBe(0);
  });
});
