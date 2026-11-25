import { parseAbi, parseEventLogs, zeroAddress } from "viem";
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
  await chain.confirm(hash);
  const receipt = await chain.publicClient.getTransactionReceipt({ hash });
  const mint = parseEventLogs({ abi: identityAbi, eventName: "Transfer", logs: receipt.logs })
    .find((l) => l.address.toLowerCase() === ERC8004.identityRegistry.toLowerCase() && l.args.from === zeroAddress);
  if (!mint) throw new Error(`registered in ${hash} but found no mint event; check it on celoscan`);
  return { agentId: mint.args.tokenId, hash };
}
