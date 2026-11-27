// Production path: the node serves eth_fillTransaction (forno does), with a stale nonce of 0.
import { fromDataSuffix } from "@celo/attribution-tags";
import { custom, keccak256, type Hex } from "viem";
import { parseTransaction as parseCelo } from "viem/celo";
import { expect, it } from "vitest";
import { makeChain } from "../src/chain.js";
import { ATTRIBUTION_CODE, TEXTILE, TOKENS, USDT_FEE_ADAPTER } from "../src/config.js";
import { account, MUM } from "./fixtures.js";

function node(gasInUsdt: boolean) {
  const sent: Hex[] = []; const calls: string[] = [];
  const transport = custom({ async request({ method, params }: { method: string; params?: any[] }) {
    calls.push(method);
    switch (method) {
      case "eth_chainId": return "0xa4ec";
      case "eth_getTransactionCount": return "0x0";
      case "eth_fillTransaction": {
        const r = params![0];
        return { raw: "0x", tx: { type: r.feeCurrency ? "0x7b" : "0x2", from: r.from, to: r.to, input: r.data ?? r.input, value: "0x0",
          nonce: "0x0", gas: "0x30000", maxFeePerGas: "0x5d21dba00", maxPriorityFeePerGas: "0x1", chainId: "0xa4ec",
          ...(r.feeCurrency ? { feeCurrency: r.feeCurrency } : {}), hash: `0x${"00".repeat(32)}`, accessList: [] } };
      }
      case "eth_getBlockByNumber": return { baseFeePerGas: "0x5d21dba00", number: "0x10", hash: `0x${"cd".repeat(32)}`, timestamp: "0x1", transactions: [] };
      case "eth_blockNumber": return "0x10";
      case "eth_sendRawTransaction": sent.push(params![0]); return keccak256(params![0]);
      case "eth_getTransactionReceipt":
        if (!sent.some((raw) => keccak256(raw) === params![0])) return null;
        return { transactionHash: params![0], status: "0x1", blockNumber: "0x10", blockHash: `0x${"cd".repeat(32)}`, logs: [], from: account.address,
          to: TEXTILE.reactor, transactionIndex: "0x0", gasUsed: "0x1", cumulativeGasUsed: "0x1", effectiveGasPrice: "0x1", logsBloom: `0x${"00".repeat(256)}`, contractAddress: null, type: "0x2" };
      default: throw new Error(`unexpected ${method}`);
    }
  } });
  return { chain: makeChain({ account, transport, gasInUsdt }), sent, calls };
}

for (const usdt of [false, true]) it(`node-filled path (gasInUsdt=${usdt}): nonces count up, tag kept, hash reported first`, async () => {
  const { chain, sent, calls } = node(usdt);
  const reported: Hex[] = [];
  await chain.approve(TOKENS.USDT, TEXTILE.reactor, 1n, async (h) => { reported.push(h); });
  await chain.send({ to: TEXTILE.reactor, data: "0xdeadbeef" }, async (h) => { reported.push(h); });
  await chain.transfer(TOKENS.CNGN, MUM, 5n, async (h) => { reported.push(h); });
  expect(calls).toContain("eth_fillTransaction");
  expect(calls).not.toContain("eth_estimateGas");
  expect(sent.map((r) => parseCelo(r).nonce ?? 0)).toEqual([0, 1, 2]);
  expect(reported).toEqual(sent.map((r) => keccak256(r)));
  for (const r of sent) expect(fromDataSuffix(parseCelo(r).data ?? "0x")?.codes).toEqual([ATTRIBUTION_CODE]);
  if (usdt) for (const r of sent) expect((parseCelo(r) as any).feeCurrency?.toLowerCase()).toBe(USDT_FEE_ADAPTER.toLowerCase());
});
