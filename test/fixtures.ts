import type { Address, Hash, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainOps, OnSent } from "../src/chain.js";
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

type Op = "approve" | "swap" | "transfer";

/**
 * In-memory chain that records every write and simulates balances and receipts.
 * Writes follow the real order: broadcast, then `onSent`, then confirm.
 * `minedButUnconfirmed` makes the next write of that kind land on chain while its confirm throws
 * (a timeout or a lagging node). `reverts` makes the next write of that kind revert. `drops` makes it
 * vanish, leaving its nonce free. `stuck` keeps it pending until `release()`, when it lands only if
 * its nonce is still free. Nonces work as on chain: each one lands at most once, in order.
 */
export function fakeChain(init: { usdt: bigint; cngn?: bigint; allowance?: bigint; swapDelivers?: bigint }) {
  const state = { usdt: init.usdt, cngn: init.cngn ?? 0n, allowance: init.allowance ?? 0n };
  const writes: { op: Op; args: unknown[] }[] = [];
  const receipts = new Map<Hash, { ok: boolean; received: bigint }>();
  const minedButUnconfirmed = new Set<Op>();
  const reverts = new Set<Op>();
  const drops = new Set<Op>();
  const stuck = new Set<Op>();
  const held: { nonce: number; free: boolean; land: () => void }[] = [];
  const flush = () => {
    for (let t; (t = held.find((x) => x.free && x.nonce === mined)); ) { held.splice(held.indexOf(t), 1); t.land(); }
    for (let i = held.length - 1; i >= 0; i--) if (held[i]!.nonce < mined) held.splice(i, 1); // replaced, never lands
  };
  let n = 0;
  let mined = 0; // nonces used so far
  let next = 0; // the nonce the agent would pick next
  const hash = () => (`0x${(++n).toString(16).padStart(64, "0")}`) as Hash;

  async function write(op: Op, args: unknown[], effect: () => bigint, onSent?: OnSent, pinned?: number): Promise<Hash> {
    const h = hash();
    const nonce = pinned ?? Math.max(next, mined);
    await onSent?.(h, nonce);
    if (nonce < mined) throw new Error("nonce too low");
    if (drops.delete(op)) { next = nonce; throw new Error("timed out waiting for the receipt"); } // never lands, no receipt ever
    next = nonce + 1;
    const land = (ok: boolean) => {
      mined = nonce + 1;
      receipts.set(h, { ok, received: ok ? effect() : 0n });
      if (ok) writes.push({ op, args });
      flush();
    };
    // A transaction waits in the mempool while it is stuck or an earlier nonce is still missing.
    const isStuck = stuck.delete(op);
    if (isStuck || nonce > mined) {
      held.push({ nonce, free: !isStuck, land: () => land(true) });
      throw new Error("timed out waiting for the receipt");
    }
    if (reverts.delete(op)) {
      land(false);
      throw new Error(`transaction reverted: ${h}`);
    }
    land(true);
    if (minedButUnconfirmed.delete(op)) throw new Error("timed out waiting for the receipt");
    return h;
  }

  const chain: ChainOps & {
    state: typeof state; writes: typeof writes; nextSwapDelivers: bigint;
    minedButUnconfirmed: Set<Op>; reverts: Set<Op>; drops: Set<Op>; stuck: Set<Op>;
    /** Mines every stuck transaction whose nonce is still free; the rest can never land. */
    release(): void;
    /** Transactions already on chain before this test, such as a swap a past run made. */
    receipts: typeof receipts;
  } = {
    agent: account.address,
    state, writes, minedButUnconfirmed, reverts, drops, stuck, receipts,
    release: () => { for (const t of held) t.free = true; flush(); },
    nextSwapDelivers: init.swapDelivers ?? 0n,
    decimals: async () => CNGN_DECIMALS,
    balance: async (t) => (t === TOKENS.USDT ? state.usdt : state.cngn),
    allowance: async () => state.allowance,
    approve: (_t, _s, amount, onSent) => {
      if (state.allowance !== 0n && amount !== 0n) throw new Error("USD₮: non-zero to non-zero approve");
      return write("approve", [amount], () => { state.allowance = amount; return 0n; }, onSent);
    },
    send: (tx: { to: Address; data: Hex }, onSent) =>
      write("swap", [tx.to], () => { state.cngn += chain.nextSwapDelivers; return chain.nextSwapDelivers; }, onSent),
    transfer: (_t, to, amount, onSent, pinned) => {
      if (state.cngn < amount) throw new Error("insufficient cNGN");
      return write("transfer", [to, amount], () => { state.cngn -= amount; return 0n; }, onSent, pinned);
    },
    nonceUsed: async (nonce) => nonce < mined,
    receiptOf: async (h) => receipts.get(h) ?? null,
  };
  return chain;
}
