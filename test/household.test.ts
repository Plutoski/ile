import { describe, expect, it } from "vitest";
import { dueDateOf, isDue, lagosDate, parseHousehold, periodOf } from "../src/household.js";
import { household, MUM } from "./fixtures.js";

const never = () => false;

describe("household.json validation", () => {
  it("accepts a valid household", () => {
    expect(household().bills).toHaveLength(2);
  });

  it("lists every problem at once", () => {
    const run = () => parseHousehold({
      name: "x", sender: "y",
      recipients: [{ id: "Mum!", name: "", address: "0x123" }],
      bills: [{ id: "a", label: "A", recipientId: "nobody", amountNgn: 12.5, schedule: { kind: "weekly" } }],
      policy: { maxUsdtPerPayout: 20, maxUsdtPerMonth: 10, maxSpreadPct: 50 },
    });
    expect(run).toThrowError(/recipients\[0\]\.id[\s\S]*address[\s\S]*not a known recipient[\s\S]*whole number[\s\S]*schedule\.kind[\s\S]*maxSpreadPct[\s\S]*cannot exceed/);
  });

  it("checksums recipient addresses", () => {
    const h = parseHousehold({ ...raw(), recipients: [{ id: "mum", name: "Mum", address: MUM.toLowerCase() }] });
    expect(h.recipients[0]!.address).toBe(MUM);
  });
});

describe("due dates (Lagos time, UTC+1)", () => {
  const [light, fees] = household().bills as [ReturnType<typeof household>["bills"][0], ReturnType<typeof household>["bills"][0]];

  it("uses the Lagos calendar day, not UTC", () => {
    expect(lagosDate(new Date("2026-12-04T23:30:00Z"))).toBe("2026-12-05");
    expect(isDue(light, new Date("2026-12-04T22:59:00Z"), never)).toBe(false);
    expect(isDue(light, new Date("2026-12-04T23:00:00Z"), never)).toBe(true);
  });

  it("clamps day 31 to the end of short months", () => {
    const b = { ...light, schedule: { kind: "monthly" as const, day: 31 } };
    expect(dueDateOf(b, new Date("2027-02-10T12:00:00Z"))).toBe("2027-02-28");
  });

  it("is not due again once paid for the period", () => {
    const now = new Date("2026-12-20T12:00:00Z");
    expect(periodOf(light, now)).toBe("2026-12");
    expect(isDue(light, now, (id, p) => id === "light" && p === "2026-12")).toBe(false);
    expect(isDue(light, new Date("2027-01-06T12:00:00Z"), (id, p) => id === "light" && p === "2026-12")).toBe(true);
  });

  it("handles one-off bills", () => {
    expect(isDue(fees, new Date("2026-11-30T12:00:00Z"), never)).toBe(false);
    expect(isDue(fees, new Date("2026-12-01T00:00:00Z"), never)).toBe(true);
    expect(isDue(fees, new Date("2027-03-01T00:00:00Z"), (id, p) => id === "fees" && p === "once")).toBe(false);
  });

  it("never pays an inactive bill", () => {
    expect(isDue({ ...light, active: false }, new Date("2026-12-20T12:00:00Z"), never)).toBe(false);
  });
});

function raw() {
  return {
    name: "h", sender: "s",
    recipients: [{ id: "mum", name: "Mum", address: MUM }],
    bills: [],
    policy: { maxUsdtPerPayout: 2, maxUsdtPerMonth: 10, maxSpreadPct: 3 },
  };
}
