import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { agentKey, registrationLink, SELF } from "../src/self.js";

// Hardhat's public test key #0, never a real wallet.
const TEST = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
// What Self's own SDK (@selfxyz/agent-sdk 0.3.1, signRegistrationChallenge + buildWalletFreeRegisterUserDataAscii,
// minimumAge 18) produces for this key, nonce 0, on Celo mainnet.
const FROM_SELF_SDK = "W1f39fd6e51aad88f6f4ce6ab8827279cfffb9226600000000000000000000000000000000000000004c5f0a7260551529e70889841457001039951d4f922164182c320f53f0723628285f2dd2d468c45262cc9856ce44cca8c62b4d77c26a2bdf3ca5a474ae2fa1c51c";

const payloadOf = (url: string) => JSON.parse(Buffer.from(url.split("payload=")[1]!, "base64url").toString("utf8"));

describe("Self Agent ID link", () => {
  it("encodes the agent's signed challenge exactly as Self's SDK does", async () => {
    const p = payloadOf(await registrationLink(TEST, 0n, new Date(0)));
    expect(p.userDefinedData).toBe(FROM_SELF_SDK);
    expect(p).toMatchObject({ mode: "wallet-free", operation: "register", chainId: 42220, registryAddress: SELF.registry,
      humanIdentifier: TEST.address, endpointType: "celo", expiresAt: 15 * 60_000 });
  });

  it("discloses only that the person is over 18", async () => {
    const { disclosures } = payloadOf(await registrationLink(TEST, 0n));
    expect(disclosures.minimumAge).toBe(18);
    expect(Object.entries(disclosures).filter(([k, v]) => k !== "minimumAge" && v)).toEqual([]);
  });

  it("puts no private key in the link", async () => {
    const url = await registrationLink(TEST, 0n);
    expect(url).not.toContain("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    expect(JSON.stringify(payloadOf(url))).not.toContain("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  });

  it("keys the agent by its address padded to 32 bytes", () => {
    expect(agentKey(TEST.address)).toBe("0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  });
});
