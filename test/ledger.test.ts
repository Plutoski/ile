import { describe, expect, it } from "vitest";
import { emptyLedger, mergeLedgers, type Decision, type Payment } from "../src/ledger.js";

const payment = (billId: string, swap: string, status: Payment["status"], transfer?: string): Payment => ({
  billId, period: "once", recipientId: "r", recipient: "0x1111111111111111111111111111111111111111", amountNgn: 2000,
  usdtSpent: "1400000", usdtFee: "0", cngnAmount: "2000000000", rate: 1428, referenceRate: null, rfqId: "q",
  txs: { swap: swap as Payment["txs"]["swap"], ...(transfer ? { transfer: transfer as Payment["txs"]["swap"] } : {}) },
  status, createdAt: `2026-11-2${billId.length % 9}T00:00:00Z`, updatedAt: "2026-11-29T00:00:00Z",
});
const decision = (reason: string): Decision => ({ at: "2026-11-29T00:00:00Z", billId: "b", period: "once", action: "failed", reason });

describe("merging two copies of the ledger", () => {
  it("keeps every payment either copy recorded", () => {
    const a = { ...emptyLedger(), payments: [payment("x", "0xaa", "paid")] };
    const b = { ...emptyLedger(), payments: [payment("y", "0xbb", "paid")] };
    expect(mergeLedgers(a, b).payments.map((p) => p.billId).sort()).toEqual(["x", "y"]);
  });

  it("keeps the copy of a purchase that got further, whichever side holds it", () => {
    const bought = { ...emptyLedger(), payments: [payment("x", "0xaa", "swapped")] };
    const sending = { ...emptyLedger(), payments: [payment("x", "0xaa", "swapped", "0xtt")] };
    const paid = { ...emptyLedger(), payments: [payment("x", "0xaa", "paid", "0xtt")] };
    expect(mergeLedgers(paid, bought).payments).toEqual(paid.payments);
    expect(mergeLedgers(bought, paid).payments).toEqual(paid.payments);
    expect(mergeLedgers(bought, sending).payments).toEqual(sending.payments);
  });

  it("at the same progress, keeps the copy saved later and every transfer either copy sent", () => {
    const first = { ...payment("x", "0xaa", "swapped", "0xt1"), updatedAt: "2026-11-29T00:00:00Z" };
    const resent = { ...payment("x", "0xaa", "swapped", "0xt2"), updatedAt: "2026-11-29T00:40:00Z", earlierTransfers: ["0xt1" as Payment["txs"]["swap"]] };
    for (const [a, b] of [[first, resent], [resent, first]]) {
      const [merged] = mergeLedgers({ ...emptyLedger(), payments: [a!] }, { ...emptyLedger(), payments: [b!] }).payments;
      expect(merged!.txs.transfer).toBe("0xt2");
      expect(merged!.earlierTransfers).toEqual(["0xt1"]);
    }
    // Even when the older copy wins, the newer copy's transfer is kept for checking.
    const older = { ...payment("x", "0xaa", "swapped", "0xt1"), updatedAt: "2026-11-29T01:00:00Z" };
    const [merged] = mergeLedgers({ ...emptyLedger(), payments: [older] }, { ...emptyLedger(), payments: [resent] }).payments;
    expect(merged!.earlierTransfers?.sort()).toEqual(["0xt1", "0xt2"].filter((h) => h !== merged!.txs.transfer));
  });

  it("keeps the higher transaction count of the two copies", () => {
    expect(mergeLedgers({ ...emptyLedger(), lastNonce: 9 }, { ...emptyLedger(), lastNonce: 11 }).lastNonce).toBe(11);
    expect(mergeLedgers(emptyLedger(), emptyLedger()).lastNonce).toBeUndefined();
  });

  it("keeps two purchases of the same bill as two entries, so neither is forgotten", () => {
    const a = { ...emptyLedger(), payments: [payment("x", "0xaa", "paid")] };
    const b = { ...emptyLedger(), payments: [payment("x", "0xbb", "swapped")] };
    expect(mergeLedgers(a, b).payments).toHaveLength(2);
  });

  it("keeps each decision once", () => {
    const a = { ...emptyLedger(), decisions: [decision("one"), decision("two")] };
    const b = { ...emptyLedger(), decisions: [decision("two"), decision("three")] };
    expect(mergeLedgers(a, b).decisions.map((d) => d.reason)).toEqual(["one", "two", "three"]);
  });
});
