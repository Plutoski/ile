import { encodePacked, getAddress, keccak256, parseSignature, type Address, type Hex, type LocalAccount } from "viem";

/**
 * Self Agent ID: ties Ilé's own wallet to a zero-knowledge proof that one real person (AJ) stands behind it.
 *
 * Registration is "wallet-free" in Self's terms: the agent's own key signs a challenge, a person scans the
 * link's QR code with the Self app and their passport, and Self's hub records the proof on Celo. The agent
 * wallet sends no transaction, so its nonce, balance and payments are untouched. Only "over 18" is disclosed.
 */
export const SELF = {
  registry: "0xaC3DF9ABf80d0F5c020C06B04Cced27763355944" as Address,
  chainId: 42220,
  appUrl: "https://agent-api.self.xyz",
  appName: "Self Agent ID",
  scope: "self-agent-id",
  disclosures: { minimumAge: 18, ofac: false, nationality: false, name: false, date_of_birth: false, gender: false, issuing_state: false },
  configIndex: 1, // minimumAge 18, no OFAC check
  linkMinutes: 15, // the link sits in a public log, so it lapses soon after the run
};

export const registryAbi = [
  { type: "function", name: "agentNonces", stateMutability: "view", inputs: [{ name: "agent", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isVerifiedAgent", stateMutability: "view", inputs: [{ name: "agentPubKey", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "getAgentId", stateMutability: "view", inputs: [{ name: "agentPubKey", type: "bytes32" }], outputs: [{ type: "uint256" }] },
] as const;

/** The registry keys an agent by its address, left-padded to 32 bytes. */
export const agentKey = (agent: Address): Hex => `0x${getAddress(agent).slice(2).toLowerCase().padStart(64, "0")}`;

/** The hash the agent signs: it binds this agent, as its own human identifier, to this registry and nonce. */
export function challengeHash(agent: Address, nonce: bigint): Hex {
  return keccak256(encodePacked(["string", "address", "uint256", "address", "uint256"],
    ["self-agent-id:register:", getAddress(agent), BigInt(SELF.chainId), SELF.registry, nonce]));
}

/** The link that shows the QR code for the Self app. Holds a signature, never the key. */
export async function registrationLink(account: LocalAccount, nonce: bigint, now = new Date()): Promise<string> {
  const hash = challengeHash(account.address, nonce);
  const sig = parseSignature(await account.signMessage({ message: { raw: hash } }));
  const v = sig.v !== undefined ? Number(sig.v) : 27 + (sig.yParity ?? 0);
  const hex = (h: Hex) => h.slice(2).toLowerCase();
  const userDefinedData = "W" + SELF.configIndex + hex(account.address) + "0".repeat(40)
    + hex(sig.r).padStart(64, "0") + hex(sig.s).padStart(64, "0") + v.toString(16).padStart(2, "0");
  const payload = {
    version: 1, operation: "register", mode: "wallet-free", chainId: SELF.chainId, registryAddress: SELF.registry,
    endpointType: "celo", appName: SELF.appName, scope: SELF.scope, humanIdentifier: getAddress(account.address),
    disclosures: SELF.disclosures, userDefinedData, expiresAt: now.getTime() + SELF.linkMinutes * 60_000,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${SELF.appUrl}/cli/register?payload=${encoded}`;
}
