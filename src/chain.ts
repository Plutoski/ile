import { withAttribution } from "@celo/attribution-tags";
import {
  createPublicClient, createWalletClient, erc20Abi, http,
  type Address, type Hash, type Hex, type LocalAccount, type PublicClient,
} from "viem";
import { celo } from "viem/chains";
import { ATTRIBUTION_CODE, DEFAULT_RPC_URL, USDT_FEE_ADAPTER } from "./config.js";

/** Everything the payment flow needs from the chain. Writes resolve only after a successful receipt. */
export interface ChainOps {
  agent: Address;
  decimals(token: Address): Promise<number>;
  balance(token: Address): Promise<bigint>;
  allowance(token: Address, spender: Address): Promise<bigint>;
  approve(token: Address, spender: Address, amount: bigint): Promise<Hash>;
  send(tx: { to: Address; data: Hex }): Promise<Hash>;
  transfer(token: Address, to: Address, amount: bigint): Promise<Hash>;
}

export interface ChainOptions {
  account: LocalAccount;
  rpcUrl?: string;
  /** Pay gas in USD₮ (fee abstraction) instead of CELO. */
  gasInUsdt?: boolean;
}

export function makePublicClient(rpcUrl = DEFAULT_RPC_URL): PublicClient {
  return createPublicClient({ chain: celo, transport: http(rpcUrl, { retryCount: 3, timeout: 30_000 }) }) as PublicClient;
}

export function makeChain({ account, rpcUrl = DEFAULT_RPC_URL, gasInUsdt = false }: ChainOptions) {
  const publicClient = makePublicClient(rpcUrl);
  // The attribution tag is attached here, once, so no call site can forget it.
  const wallet = createWalletClient({ account, chain: celo, transport: http(rpcUrl, { retryCount: 3, timeout: 30_000 }) })
    .extend(withAttribution(ATTRIBUTION_CODE));
  const fee = gasInUsdt ? { feeCurrency: USDT_FEE_ADAPTER } : {};

  const confirm = async (hash: Hash): Promise<Hash> => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
    return hash;
  };

  const ops: ChainOps = {
    agent: account.address,
    decimals: (token) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    balance: (token) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    allowance: (token, spender) =>
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account.address, spender] }),
    approve: async (token, spender, amount) =>
      confirm(await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount], ...fee })),
    send: async ({ to, data }) => confirm(await wallet.sendTransaction({ to, data, value: 0n, ...fee })),
    transfer: async (token, to, amount) =>
      confirm(await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [to, amount], ...fee })),
  };
  return { ...ops, publicClient, wallet, fee, confirm };
}
