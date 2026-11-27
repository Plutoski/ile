import { withAttribution } from "@celo/attribution-tags";
import {
  TransactionReceiptNotFoundError, createPublicClient, createWalletClient, custom, erc20Abi, http, keccak256,
  type Address, type Hash, type Hex, type LocalAccount, type PublicClient, type TransactionReceipt, type Transport,
} from "viem";
import { celo } from "viem/chains";
import { ATTRIBUTION_CODE, DEFAULT_RPC_URL, USDT_FEE_ADAPTER } from "./config.js";
import { tokenFlows } from "./receipts.js";

/** What a mined transaction did, as far as the payment flow cares. */
export interface TxOutcome {
  ok: boolean;
  /** How much of the token asked about the agent received in this transaction. */
  received: bigint;
}

/** Called with the hash and nonce as soon as a transaction is broadcast, before waiting for it to be mined. */
export type OnSent = (hash: Hash, nonce: number) => Promise<void>;

/**
 * Everything the payment flow needs from the chain. Writes resolve only after a
 * successful receipt; `onSent` lets the caller record the hash first, so a lost
 * confirmation can never hide a transaction that went through.
 */
export interface ChainOps {
  agent: Address;
  decimals(token: Address): Promise<number>;
  balance(token: Address): Promise<bigint>;
  allowance(token: Address, spender: Address): Promise<bigint>;
  approve(token: Address, spender: Address, amount: bigint, onSent?: OnSent): Promise<Hash>;
  send(tx: { to: Address; data: Hex }, onSent?: OnSent): Promise<Hash>;
  /** `nonce` pins the transaction to a nonce, so it can only land in place of an earlier one sent with that nonce. */
  transfer(token: Address, to: Address, amount: bigint, onSent?: OnSent, nonce?: number): Promise<Hash>;
  /** True once a mined transaction from the agent has used this nonce. */
  nonceUsed(nonce: number): Promise<boolean>;
  /** How many of the agent's transactions are mined. */
  sentCount(): Promise<number>;
  /** The outcome of a transaction, or null if no node we reach has it yet. */
  receiptOf(hash: Hash, token: Address): Promise<TxOutcome | null>;
}

export interface ChainOptions {
  account: LocalAccount;
  rpcUrl?: string;
  /** Overrides the HTTP connection to rpcUrl. Tests pass a fake node here. */
  transport?: Transport;
  /** Pay gas in USD₮ (fee abstraction) instead of CELO. */
  gasInUsdt?: boolean;
}

export function makePublicClient(rpcUrl = DEFAULT_RPC_URL): PublicClient {
  return createPublicClient({ chain: celo, transport: http(rpcUrl, { retryCount: 3, timeout: 30_000 }) }) as PublicClient;
}

export function makeChain({ account, rpcUrl = DEFAULT_RPC_URL, transport, gasInUsdt = false }: ChainOptions) {
  const conn = transport ?? http(rpcUrl, { retryCount: 3, timeout: 30_000 });
  const publicClient = createPublicClient({ chain: celo, transport: conn, pollingInterval: transport ? 10 : undefined }) as PublicClient;

  // The wallet's connection reports each signed transaction's hash just before it goes out.
  // A node can accept a transaction and then fail to answer; the hash is on record either way.
  let beforeBroadcast: ((hash: Hash) => Promise<void>) | undefined;
  // The wallet client already retries; one layer is enough. http() keeps its own retryCount, so build it without retries.
  const node = (transport ?? http(rpcUrl, { retryCount: 0, timeout: 30_000 }))({ chain: celo, retryCount: 0 });
  const recording = custom({
    async request({ method, params }) {
      if (method === "eth_sendRawTransaction" && beforeBroadcast) {
        const report = beforeBroadcast;
        beforeBroadcast = undefined;
        await report(keccak256((params as [Hex])[0]));
      }
      return node.request({ method, params });
    },
  });
  // The attribution tag is attached here, once, so no call site can forget it.
  const wallet = createWalletClient({ account, chain: celo, transport: recording }).extend(withAttribution(ATTRIBUTION_CODE));
  const fee = gasInUsdt ? { feeCurrency: USDT_FEE_ADAPTER } : {};

  // forno is load-balanced and its nodes lag each other. Two consequences handled here:
  // the receipt from a confirmation is kept, never fetched again from a node that may not have it,
  // and nonces count up locally, never below what this run already used.
  const receipts = new Map<Hash, TransactionReceipt>();
  let nextNonce = 0;

  const confirm = async (hash: Hash): Promise<TransactionReceipt> => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
      throw new Error(`transaction ${hash} was replaced by ${receipt.transactionHash}`);
    }
    receipts.set(hash, receipt);
    if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
    return receipt;
  };

  const write = async (broadcast: (nonce: number) => Promise<Hash>, onSent?: OnSent, pinned?: number): Promise<Hash> => {
    const nonce = pinned ?? Math.max(await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }), nextNonce);
    let reported: Hash | undefined;
    beforeBroadcast = async (hash) => { reported = hash; await onSent?.(hash, nonce); };
    let hash: Hash;
    try {
      hash = await broadcast(nonce);
    } finally {
      beforeBroadcast = undefined;
    }
    nextNonce = Math.max(nextNonce, nonce + 1);
    if (reported === undefined) await onSent?.(hash, nonce);
    else if (reported !== hash) throw new Error(`broadcast returned ${hash}, but the signed transaction hashes to ${reported}`);
    await confirm(hash);
    return hash;
  };

  const receiptOf = async (hash: Hash, token: Address): Promise<TxOutcome | null> => {
    let receipt = receipts.get(hash);
    for (let attempt = 1; !receipt && attempt <= 3; attempt++) {
      try {
        receipt = await publicClient.getTransactionReceipt({ hash });
      } catch (e) {
        if (!(e instanceof TransactionReceiptNotFoundError)) throw e;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 2_000));
      }
    }
    if (!receipt) return null;
    return { ok: receipt.status === "success", received: tokenFlows(receipt.logs, token, account.address).received };
  };

  const ops: ChainOps = {
    agent: account.address,
    decimals: (token) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    balance: (token) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    allowance: (token, spender) =>
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account.address, spender] }),
    approve: (token, spender, amount, onSent) =>
      write((nonce) => wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount], nonce, ...fee }), onSent),
    send: ({ to, data }, onSent) => write((nonce) => wallet.sendTransaction({ to, data, value: 0n, nonce, ...fee }), onSent),
    transfer: (token, to, amount, onSent, pinned) =>
      write((nonce) => wallet.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [to, amount], nonce, ...fee }), onSent, pinned),
    nonceUsed: async (nonce) => (await publicClient.getTransactionCount({ address: account.address, blockTag: "latest" })) > nonce,
    sentCount: () => publicClient.getTransactionCount({ address: account.address, blockTag: "latest" }),
    receiptOf,
  };
  return { ...ops, publicClient, wallet, fee, confirm };
}
