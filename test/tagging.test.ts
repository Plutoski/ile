import { fromDataSuffix, withAttribution } from "@celo/attribution-tags";
import { createWalletClient, custom, erc20Abi, parseTransaction, recoverTypedDataAddress, type Hex } from "viem";
import { parseTransaction as parseCeloTransaction } from "viem/celo";
import { celo } from "viem/chains";
import { describe, expect, it } from "vitest";
import { ATTRIBUTION_CODE, CHAIN_ID, TEXTILE, TOKENS, USDT_FEE_ADAPTER } from "../src/config.js";
import { signTakerProof } from "../src/textile.js";
import { account, MUM } from "./fixtures.js";

/** A wallet built exactly like the agent's, over a fake node that captures signed transactions. */
function capturingWallet() {
  const sent: Hex[] = [];
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown[] }) {
      switch (method) {
        case "eth_chainId": return `0x${CHAIN_ID.toString(16)}`;
        case "eth_getTransactionCount": return "0x0";
        case "eth_estimateGas": return "0x30000";
        case "eth_gasPrice": return "0x5d21dba00";
        case "eth_maxPriorityFeePerGas": return "0x1";
        case "eth_getBlockByNumber": return { baseFeePerGas: "0x5d21dba00", number: "0x1", timestamp: "0x1", transactions: [] };
        case "eth_sendRawTransaction": sent.push((params as Hex[])[0]!); return `0x${"ab".repeat(32)}`;
        default: throw new Error(`unexpected RPC ${method}`);
      }
    },
  });
  const wallet = createWalletClient({ account, chain: celo, transport }).extend(withAttribution(ATTRIBUTION_CODE));
  return { wallet, sent };
}

const tagOf = (raw: Hex) => fromDataSuffix(parseCeloTransaction(raw).data ?? "0x");

describe("attribution tag", () => {
  it("is on approvals, swaps and transfers alike", async () => {
    const { wallet, sent } = capturingWallet();
    await wallet.writeContract({ address: TOKENS.USDT, abi: erc20Abi, functionName: "approve", args: [TEXTILE.reactor, 1n] });
    await wallet.sendTransaction({ to: TEXTILE.reactor, data: "0xdeadbeef", value: 0n });
    await wallet.writeContract({ address: TOKENS.CNGN, abi: erc20Abi, functionName: "transfer", args: [MUM, 5n] });

    expect(sent).toHaveLength(3);
    for (const raw of sent) expect(tagOf(raw)?.codes).toEqual([ATTRIBUTION_CODE]);
  });

  it("keeps the swap calldata intact before the tag", async () => {
    const { wallet, sent } = capturingWallet();
    await wallet.sendTransaction({ to: TEXTILE.reactor, data: "0xdeadbeef", value: 0n });
    expect(parseTransaction(sent[0]!).data?.startsWith("0xdeadbeef")).toBe(true);
  });

  it("survives paying gas in USD₮", async () => {
    const { wallet, sent } = capturingWallet();
    await wallet.sendTransaction({ to: TEXTILE.reactor, data: "0xdeadbeef", value: 0n, feeCurrency: USDT_FEE_ADAPTER });
    const tx = parseCeloTransaction(sent[0]!) as { type?: string; feeCurrency?: string };
    expect(tx.type).toBe("cip64");
    expect(tx.feeCurrency?.toLowerCase()).toBe(USDT_FEE_ADAPTER.toLowerCase());
    expect(tagOf(sent[0]!)?.codes).toEqual([ATTRIBUTION_CODE]);
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
