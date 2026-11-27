import { fromDataSuffix } from "@celo/attribution-tags";
import { custom, keccak256, parseTransaction, recoverTypedDataAddress, type Hex } from "viem";
import { parseTransaction as parseCeloTransaction } from "viem/celo";
import { celo } from "viem/chains";
import { describe, expect, it } from "vitest";
import { ATTRIBUTION_CODE, CHAIN_ID, TEXTILE, TOKENS, USDT_FEE_ADAPTER } from "../src/config.js";
import { makeChain } from "../src/chain.js";
import { signTakerProof } from "../src/textile.js";
import { account, MUM } from "./fixtures.js";

/**
 * The agent's real chain client over a fake Celo node. The node mines every transaction at once,
 * and always reports a stale pending transaction count of 0, like a node that lags behind.
 */
function agentOnFakeNode(gasInUsdt = false, opts: { loseReply?: boolean; replaceWith?: Hex; forgetReceipts?: boolean; failGasWhile?: () => boolean } = {}) {
  const sent: Hex[] = [];
  const calls: string[] = [];

  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown[] }) {
      const p = (params ?? []) as Hex[];
      calls.push(method);
      switch (method) {
        case "eth_chainId": return `0x${CHAIN_ID.toString(16)}`;
        case "eth_getTransactionCount": return "0x0"; // stale: never counts what this run already sent
        case "eth_estimateGas":

          if (opts.failGasWhile?.()) throw Object.assign(new Error("execution reverted"), { code: 3 });
          return "0x30000";
        case "eth_gasPrice": return "0x5d21dba00";
        case "eth_maxPriorityFeePerGas": return "0x1";
        case "eth_blockNumber": return "0x10";
        case "eth_getBlockByNumber": return { baseFeePerGas: "0x5d21dba00", number: "0x10", hash: `0x${"cd".repeat(32)}`, timestamp: "0x1", transactions: [] };
        case "eth_sendRawTransaction":
          sent.push(p[0]!);
          if (opts.loseReply) throw Object.assign(new Error("502 Bad Gateway"), { code: -32603 }); // accepted, then no answer
          return keccak256(p[0]!);
        case "eth_getTransactionReceipt": {
          if (opts.forgetReceipts && calls.filter((c) => c === "eth_getTransactionReceipt").length > 1) return null;
          if (!sent.some((raw) => keccak256(raw) === p[0])) return null;
          return {
            transactionHash: opts.replaceWith ?? p[0], status: "0x1", blockNumber: "0x10", blockHash: `0x${"cd".repeat(32)}`, logs: [],
            from: account.address, to: TEXTILE.reactor, transactionIndex: "0x0", gasUsed: "0x1", cumulativeGasUsed: "0x1",
            effectiveGasPrice: "0x1", logsBloom: `0x${"00".repeat(256)}`, contractAddress: null, type: "0x2",
          };
        }
        case "eth_fillTransaction": throw Object.assign(new Error("method not found"), { code: -32601 }); // a node without it: the wallet fills it in locally (forno has it; see fill.test.ts)
        default: throw new Error(`unexpected RPC ${method}`);
      }
    },
  });
  return { chain: makeChain({ account, transport, gasInUsdt }), sent, calls };
}

const tagOf = (raw: Hex) => fromDataSuffix(parseCeloTransaction(raw).data ?? "0x");

describe("the agent's transactions", () => {
  it("carry the attribution tag on approvals, swaps and transfers alike", async () => {
    const { chain, sent } = agentOnFakeNode();
    await chain.approve(TOKENS.USDT, TEXTILE.reactor, 1n);
    await chain.send({ to: TEXTILE.reactor, data: "0xdeadbeef" });
    await chain.transfer(TOKENS.CNGN, MUM, 5n);

    expect(sent).toHaveLength(3);
    for (const raw of sent) expect(tagOf(raw)?.codes).toEqual([ATTRIBUTION_CODE]);
  });

  it("keep the swap calldata intact before the tag", async () => {
    const { chain, sent } = agentOnFakeNode();
    await chain.send({ to: TEXTILE.reactor, data: "0xdeadbeef" });
    expect(parseTransaction(sent[0]!).data?.startsWith("0xdeadbeef")).toBe(true);
  });

  it("keep the tag when gas is paid in USD₮", async () => {
    const { chain, sent } = agentOnFakeNode(true);
    await chain.send({ to: TEXTILE.reactor, data: "0xdeadbeef" });
    const tx = parseCeloTransaction(sent[0]!) as { type?: string; feeCurrency?: string };
    expect(tx.type).toBe("cip64");
    expect(tx.feeCurrency?.toLowerCase()).toBe(USDT_FEE_ADAPTER.toLowerCase());
    expect(tagOf(sent[0]!)?.codes).toEqual([ATTRIBUTION_CODE]);
  });

  it("count nonces up within a run even when the node reports a stale count", async () => {
    const { chain, sent } = agentOnFakeNode();
    await chain.approve(TOKENS.USDT, TEXTILE.reactor, 1n);
    await chain.send({ to: TEXTILE.reactor, data: "0xdeadbeef" });
    await chain.transfer(TOKENS.CNGN, MUM, 5n);
    expect(sent.map((raw) => parseCeloTransaction(raw).nonce)).toEqual([0, 1, 2]);
  });

  it("report the hash before it is broadcast, so a lost reply cannot hide it", async () => {
    const { chain, sent, calls } = agentOnFakeNode();
    let callsAtReport = -1;
    const hash = await chain.send({ to: TEXTILE.reactor, data: "0xdeadbeef" }, async () => { callsAtReport = calls.length; });
    expect(calls.slice(callsAtReport)[0]).toBe("eth_sendRawTransaction"); // reported first, then sent
    expect(hash).toBe(keccak256(sent[0]!));
  });

  it("still report the hash when the node accepts the transaction and then fails to answer", async () => {
    const { chain, sent } = agentOnFakeNode(false, { loseReply: true });
    const reported: Hex[] = [];
    await expect(chain.transfer(TOKENS.CNGN, MUM, 5n, async (h) => { reported.push(h); })).rejects.toThrow();
    expect(sent).toHaveLength(1);
    expect(reported).toEqual([keccak256(sent[0]!)]);
  });

  it("refuse a receipt that belongs to a replacement transaction", async () => {
    const { chain } = agentOnFakeNode(false, { replaceWith: `0x${"ee".repeat(32)}` });
    await expect(chain.send({ to: TEXTILE.reactor, data: "0xdeadbeef" })).rejects.toThrow(/replaced/);
  });

  it("answer from the receipt they confirmed with, even when the next node has not seen it", async () => {
    const { chain } = agentOnFakeNode(false, { forgetReceipts: true });
    const hash = await chain.send({ to: TEXTILE.reactor, data: "0xdeadbeef" });
    expect(await chain.receiptOf(hash, TOKENS.CNGN)).toEqual({ ok: true, received: 0n });
  });

  it("reuse the nonce of a transaction that failed before it was sent", async () => {
    let failing = false;
    const { chain, sent } = agentOnFakeNode(false, { failGasWhile: () => failing });
    await chain.approve(TOKENS.USDT, TEXTILE.reactor, 1n);
    failing = true; // the swap fails before it is sent, retries included
    await expect(chain.send({ to: TEXTILE.reactor, data: "0xdeadbeef" })).rejects.toThrow();
    failing = false;
    await chain.transfer(TOKENS.CNGN, MUM, 5n);
    expect(sent.map((raw) => parseCeloTransaction(raw).nonce)).toEqual([0, 1]);
  });
});

describe("Textile proof of control", () => {
  it("is an EIP-712 signature that recovers to the agent", async () => {
    const proof = await signTakerProof(account, 1_756_400_000_000);
    const signer = await recoverTypedDataAddress({
      domain: { name: "Textile Taker Control", version: "1", chainId: CHAIN_ID },
      types: { TakerControl: [
        { name: "taker", type: "address" }, { name: "chainId", type: "uint256" },
        { name: "nonce", type: "bytes32" }, { name: "issuedAt", type: "uint256" },
      ] },
      primaryType: "TakerControl",
      message: { taker: account.address, chainId: BigInt(CHAIN_ID), nonce: proof.nonce, issuedAt: BigInt(proof.issuedAt) },
      signature: proof.signature,
    });
    expect(signer).toBe(account.address);
    expect(proof.nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("uses a fresh nonce every time", async () => {
    const [a, b] = await Promise.all([signTakerProof(account), signTakerProof(account)]);
    expect(a.nonce).not.toBe(b.nonce);
  });
});
