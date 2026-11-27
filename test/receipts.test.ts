import { toDataSuffix } from "@celo/attribution-tags";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hash, type Log } from "viem";
import { describe, expect, it, vi } from "vitest";
import { adoptSwap } from "../src/adopt.js";
import { ATTRIBUTION_CODE, TEXTILE, TOKENS } from "../src/config.js";
import { emptyLedger } from "../src/ledger.js";
import { payBill } from "../src/payout.js";
import { FEE_DEBIT_ADDRESS, tokenFlows } from "../src/receipts.js";
import { account, fakeChain, firmQuote } from "./fixtures.js";
import { parseHousehold } from "../src/household.js";

const AGENT = account.address;
const MAKER: Address = "0xa601E4AdAE099c1C98a2186Fc0A151DC4BFBBA40";
const FEE_TO: Address = "0x51727A09b55d56BF8f3CBe61f460327330aECbA4";
const HALIMAH: Address = "0x70Db9413327F370098DE8061BFd377b692De30E5";
const SWAP: Hash = "0x7e9690d4476337911440f899f30ac7597cc632e002b7f603f412e1fab1a65802";

const transfer = (token: Address, from: Address, to: Address, value: bigint): Log => ({
  address: token,
  topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }) as Log["topics"],
  data: encodeAbiParameters([{ type: "uint256" }], [value]),
  blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false,
});

/** The token movements of the real first swap (celoscan tx 0x7e9690…5802), with gas paid in USD₮. */
const realSwapLogs = (agent: Address = AGENT): Log[] => [
  transfer(TOKENS.USDT, agent, FEE_DEBIT_ADDRESS, 3395n),
  transfer(TOKENS.CNGN, MAKER, agent, 3000_000000n),
  transfer(TOKENS.USDT, agent, MAKER, 2_082819n),
  transfer(TOKENS.USDT, agent, FEE_TO, 416n),
  transfer(TOKENS.USDT, FEE_DEBIT_ADDRESS, agent, 308n),
];

const household = () => parseHousehold({
  name: "Test family", sender: "AJ (Calgary)",
  recipients: [{ id: "halimah", name: "Halimah", relation: "sister", address: HALIMAH }],
  bills: [{ id: "halimah-electricity", label: "Electricity", recipientId: "halimah", amountNgn: 3000, schedule: { kind: "once", date: "2026-11-28" } }],
  policy: { maxUsdtPerPayout: 3, maxUsdtPerMonth: 10, maxSpreadPct: 3 },
});

const evidence = (over: Partial<Parameters<typeof adoptSwap>[0]["swap"]> = {}) => ({
  hash: SWAP, from: AGENT, to: TEXTILE.reactor as Address, status: "success" as const,
  input: (`0xdeadbeef${toDataSuffix(ATTRIBUTION_CODE).slice(2)}`) as `0x${string}`,
  logs: realSwapLogs(), ...over,
});

describe("reading token flows from a receipt", () => {
  it("separates the swap from gas paid in USD₮", () => {
    const usdt = tokenFlows(realSwapLogs(), TOKENS.USDT, AGENT);
    expect(usdt.sent).toBe(2_083235n); // maker + Textile fee, without the 3395 gas debit
    expect(usdt.received).toBe(0n); // the gas refund is not income
    expect(tokenFlows(realSwapLogs(), TOKENS.CNGN, AGENT)).toMatchObject({ received: 3000_000000n, from: [MAKER] });
  });
});

describe("adopting a swap that was never recorded", () => {
  const now = new Date("2026-11-25T23:10:00Z");

  it("records the real first swap as bought-but-not-delivered", () => {
    const ledger = { ...emptyLedger(), agent: AGENT };
    const h = household();
    const p = adoptSwap({ ledger, household: h, bill: h.bills[0]!, agent: AGENT, swap: evidence(), cngnDecimals: 6, now });
    expect(p).toMatchObject({ status: "swapped", usdtSpent: "2083235", usdtFee: "416", cngnAmount: "3000000000", recipient: HALIMAH });
    expect(p.rate).toBeCloseTo(1440.07, 1);
  });

  it("then pay only delivers: no second purchase", async () => {
    const ledger = { ...emptyLedger(), agent: AGENT };
    const h = household();
    adoptSwap({ ledger, household: h, bill: h.bills[0]!, agent: AGENT, swap: evidence(), cngnDecimals: 6, now });
    const chain = fakeChain({ usdt: 8_000000n, cngn: 3000_000000n });
    chain.receipts.set(ledger.payments[0]!.txs.swap, { ok: true, received: 3000_000000n });
    const requestQuote = vi.fn();
    const out = await payBill(h.bills[0]!, h, {
      chain, ledger, persist: async () => {}, now: () => now, reference: async () => ({ rate: 1400, sources: [] }),
      textile: { requestQuote, cancel: vi.fn(async () => {}), submit: vi.fn(async () => {}) },
    });
    expect(out.kind).toBe("paid");
    expect(requestQuote).not.toHaveBeenCalled();
    expect(chain.writes).toEqual([{ op: "transfer", args: [HALIMAH, 3000_000000n] }]);
  });

  it.each([
    ["a reverted transaction", { status: "reverted" as const }, /reverted/],
    ["someone else's transaction", { from: "0x3333333333333333333333333333333333333333" as Address }, /not sent by the agent/],
    ["a transaction not sent to Textile", { to: "0x3333333333333333333333333333333333333333" as Address }, /not a Textile swap/],
    ["an untagged transaction", { input: "0xdeadbeef" as `0x${string}` }, /attribution tag/],
    ["the wrong amount of naira", { logs: [transfer(TOKENS.CNGN, MAKER, AGENT, 2000_000000n), transfer(TOKENS.USDT, AGENT, MAKER, 1n)] }, /delivered 2000000000/],
  ])("refuses %s", (_name, over, error) => {
    const h = household();
    expect(() => adoptSwap({ ledger: { ...emptyLedger(), agent: AGENT }, household: h, bill: h.bills[0]!, agent: AGENT, swap: evidence(over), cngnDecimals: 6, now }))
      .toThrowError(error);
  });

  it("refuses to adopt twice", () => {
    const ledger = { ...emptyLedger(), agent: AGENT };
    const h = household();
    adoptSwap({ ledger, household: h, bill: h.bills[0]!, agent: AGENT, swap: evidence(), cngnDecimals: 6, now });
    expect(() => adoptSwap({ ledger, household: h, bill: h.bills[0]!, agent: AGENT, swap: evidence(), cngnDecimals: 6, now })).toThrowError(/already has a payment/);
  });
});

describe("stale balance reads (the first-payout bug)", () => {
  it("pays correctly even when the node reports the old cNGN balance after the swap", async () => {
    const now = new Date("2026-11-28T10:00:00Z");
    const h = household();
    const chain = fakeChain({ usdt: 8_000000n, swapDelivers: 3000_000000n });
    const realBalance = chain.balance;
    chain.balance = async (t) => (t === TOKENS.CNGN ? 0n : realBalance(t)); // a node one block behind
    const ledger = { ...emptyLedger(), agent: AGENT };
    const out = await payBill(h.bills[0]!, h, {
      chain, ledger, persist: async () => {}, now: () => now, sleep: async () => {},
      reference: async () => ({ rate: 1400, sources: [] }),
      textile: { requestQuote: async () => ({ status: "quoted", firm: firmQuote(3000, 2.08, now.getTime()) }), cancel: vi.fn(async () => {}), submit: vi.fn(async () => {}) },
    });
    expect(out).toEqual({ kind: "paid", payment: expect.anything() });
    expect(chain.writes.map((w) => w.op)).toEqual(["approve", "swap", "transfer"]);
  });
});
