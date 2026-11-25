import type { Address, Hash, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainOps } from "../src/chain.js";
import { TEXTILE, TOKENS } from "../src/config.js";
import { parseHousehold } from "../src/household.js";
import type { FirmQuote } from "../src/textile.js";

// Well-known test key (anvil #0). Never funded on mainnet.
export const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
export const MUM: Address = "0x1111111111111111111111111111111111111111";

export const household = () => parseHousehold({
  name: "Test household",
  sender: "AJ",
  recipients: [{ id: "mum", name: "Mum", relation: "mother", address: MUM }],
  bills: [
    { id: "light", label: "Electricity", category: "utilities", recipientId: "mum", amountNgn: 2000, schedule: { kind: "monthly", day: 5 } },
    { id: "fees", label: "School fees", category: "education", recipientId: "mum", amountNgn: 3000, schedule: { kind: "once", date: "2026-12-01" } },
  ],
  policy: { maxUsdtPerPayout: 3, maxUsdtPerMonth: 10, maxSpreadPct: 3 },
});

export const CNGN_DECIMALS = 6;

/** A Textile firm quote for `ngn` naira costing `usdt` dollars, valid for 60s from `now`. */
export function firmQuote(ngn: number, usdt: number, now: number, over: Partial<FirmQuote["quote"]> = {}): FirmQuote {
  const takerPays = BigInt(Math.round(usdt * 1e6));
  return {
    rfqId: "rfq_test",
    claimToken: "rfqc_test",
    quote: {
      sellAmount: takerPays.toString(),
      buyAmount: (BigInt(ngn) * 10n ** BigInt(CNGN_DECIMALS)).toString(),
      feeAmount: (takerPays / 5000n).toString(),
      takerPays: takerPays.toString(),
      rateRay: "0",
      expiresAt: new Date(now + 60_000).toISOString(),
      orderDeadline: new Date(now + 120_000).toISOString(),
      reactor: TEXTILE.reactor,
      taker: account.address,
      ...over,
    },
    transactions: {
      approval: { to: TOKENS.USDT, data: "0x095ea7b3", value: "0", chainId: 42220 },
      swap: { to: TEXTILE.reactor, data: "0xdeadbeef", value: "0", chainId: 42220 },
    },
  };
}

/** In-memory chain that records every write, and simulates the swap and transfer balance changes. */
export function fakeChain(init: { usdt: bigint; cngn?: bigint; allowance?: bigint; swapDelivers?: bigint }) {
  const state = { usdt: init.usdt, cngn: init.cngn ?? 0n, allowance: init.allowance ?? 0n };
  const writes: { op: string; args: unknown[] }[] = [];
  let n = 0;
  const hash = () => (`0x${(++n).toString(16).padStart(64, "0")}`) as Hash;
  const chain: ChainOps & { state: typeof state; writes: typeof writes; nextSwapDelivers: bigint } = {
    agent: account.address,
    state, writes,
    nextSwapDelivers: init.swapDelivers ?? 0n,
    decimals: async () => CNGN_DECIMALS,
    balance: async (t) => (t === TOKENS.USDT ? state.usdt : state.cngn),
    allowance: async () => state.allowance,
    approve: async (_t, _s, amount) => {
      if (state.allowance !== 0n && amount !== 0n) throw new Error("USD₮: non-zero to non-zero approve");
      state.allowance = amount;
      writes.push({ op: "approve", args: [amount] });
      return hash();
    },
    send: async (tx: { to: Address; data: Hex }) => {
      writes.push({ op: "swap", args: [tx.to] });
      state.cngn += chain.nextSwapDelivers;
      return hash();
    },
    transfer: async (_t, to, amount) => {
      if (state.cngn < amount) throw new Error("insufficient cNGN");
      state.cngn -= amount;
      writes.push({ op: "transfer", args: [to, amount] });
      return hash();
    },
  };
  return chain;
}
