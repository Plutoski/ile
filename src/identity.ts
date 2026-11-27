import { parseAbi, parseEventLogs, zeroAddress, type Hex } from "viem";
import type { makeChain } from "./chain.js";
import { ERC8004 } from "./config.js";

export const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

export const reputationAbi = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function getClients(uint256 agentId) view returns (address[])",
]);

/**
 * Register the agent on the ERC-8004 identity registry from the agent wallet.
 * The ID is read from the ERC-721 mint in the receipt, not from a simulated
 * return value, which can be wrong if another agent registers in the same block.
 */
export async function registerAgent(chain: ReturnType<typeof makeChain>, agentURI: string) {
  const hash = await chain.wallet.writeContract({
    address: ERC8004.identityRegistry, abi: identityAbi, functionName: "register", args: [agentURI], ...chain.fee,
  });
  const receipt = await chain.confirm(hash);
  const mint = parseEventLogs({ abi: identityAbi, eventName: "Transfer", logs: receipt.logs })
    .find((l) => l.address.toLowerCase() === ERC8004.identityRegistry.toLowerCase() && l.args.from === zeroAddress);
  if (!mint) throw new Error(`registered in ${hash} but found no mint event; check it on celoscan`);
  return { agentId: mint.args.tokenId, hash };
}

type IdentityChain = Pick<ReturnType<typeof makeChain>, "agent" | "publicClient" | "wallet" | "fee" | "confirm">;

/**
 * Point the agent's ERC-8004 registration at a new agent card.
 * Safe to rerun: when the registry already returns `uri`, it sends nothing.
 * The check after sending reads at the receipt's block, because a lagging
 * node can return the old value right after a transaction confirms.
 */
export async function setAgentURI(chain: IdentityChain, agentId: bigint, uri: string, retryDelayMs = 2_000): Promise<{ hash: Hex | null }> {
  const registry = { address: ERC8004.identityRegistry, abi: identityAbi } as const;
  const current = await chain.publicClient.readContract({ ...registry, functionName: "tokenURI", args: [agentId] });
  if (current === uri) return { hash: null };
  const owner = await chain.publicClient.readContract({ ...registry, functionName: "ownerOf", args: [agentId] });
  if (owner.toLowerCase() !== chain.agent.toLowerCase()) {
    throw new Error(`agent #${agentId} is owned by ${owner}, not the agent wallet ${chain.agent}`);
  }
  const hash = await chain.wallet.writeContract({ ...registry, functionName: "setAgentURI", args: [agentId, uri], ...chain.fee });
  const { blockNumber } = await chain.confirm(hash);
  // A node behind the one that saw the receipt answers "block is out of range" until it catches up.
  let after: string | undefined;
  for (let attempt = 1; after === undefined; attempt++) {
    try {
      after = await chain.publicClient.readContract({ ...registry, functionName: "tokenURI", args: [agentId], blockNumber });
    } catch (e) {
      if (attempt >= 6) throw new Error(`setAgentURI ${hash} confirmed, but block ${blockNumber} could not be read back: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  if (after !== uri) throw new Error(`setAgentURI ${hash} confirmed, but the registry returns ${after}`);
  return { hash };
}
