import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { setAgentURI } from "../src/identity.js";

const AGENT = "0x2E5b3E46Db5d842EF5be17867900C428E635eB51";
const NEW_URI = "https://ile-family.pages.dev/agent.json";
const OLD_URI = "https://ile-docs.vercel.app/agent.json";
const TX = `0x${"ab".repeat(32)}` as Hex;

/** A registry where `uriAt(block)` is what tokenURI returns at that block ("latest" when none is given). */
function fakeChain(opts: { owner?: string; uriAt: (block?: bigint) => string; receiptBlock?: bigint; laggingReads?: number }) {
  let lagging = opts.laggingReads ?? 0;
  const sent: unknown[] = [];
  const chain = {
    agent: AGENT,
    fee: {},
    confirm: async () => ({ blockNumber: opts.receiptBlock ?? 100n }),
    wallet: { writeContract: async (call: unknown) => { sent.push(call); return TX; } },
    publicClient: {
      readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
        if (functionName === "ownerOf") return opts.owner ?? AGENT;
        if (blockNumber !== undefined && lagging > 0) { lagging--; throw new Error("block is out of range"); }
        return opts.uriAt(blockNumber);
      },
    },
  };
  return { chain: chain as unknown as Parameters<typeof setAgentURI>[0], sent };
}

describe("setAgentURI", () => {
  it("sends nothing when the registry already points at the URL", async () => {
    const { chain, sent } = fakeChain({ uriAt: () => NEW_URI });
    expect(await setAgentURI(chain, 10136n, NEW_URI)).toEqual({ hash: null });
    expect(sent).toHaveLength(0);
  });

  it("refuses when the agent wallet does not own the identity", async () => {
    const { chain, sent } = fakeChain({ owner: "0x000000000000000000000000000000000000dEaD", uriAt: () => OLD_URI });
    await expect(setAgentURI(chain, 10136n, NEW_URI)).rejects.toThrow(/not the agent wallet/);
    expect(sent).toHaveLength(0);
  });

  it("checks the new URL at the receipt's block, not on a lagging latest read", async () => {
    // Latest still shows the old value (lagging node); the receipt's block shows the new one.
    const { chain, sent } = fakeChain({ receiptBlock: 100n, uriAt: (b) => (b === 100n ? NEW_URI : OLD_URI) });
    expect(await setAgentURI(chain, 10136n, NEW_URI)).toEqual({ hash: TX });
    expect(sent).toHaveLength(1);
  });

  it("waits for a lagging node to reach the receipt's block instead of failing", async () => {
    const { chain } = fakeChain({ laggingReads: 2, uriAt: (b) => (b === 100n ? NEW_URI : OLD_URI) });
    expect(await setAgentURI(chain, 10136n, NEW_URI, 0)).toEqual({ hash: TX });
  });

  it("gives up with a clear error when the node never reaches the block", async () => {
    const { chain } = fakeChain({ laggingReads: 99, uriAt: (b) => (b === undefined ? OLD_URI : NEW_URI) });
    await expect(setAgentURI(chain, 10136n, NEW_URI, 0)).rejects.toThrow(/could not be read back/);
  });

  it("fails loudly when the registry did not take the new URL", async () => {
    const { chain } = fakeChain({ uriAt: () => OLD_URI });
    await expect(setAgentURI(chain, 10136n, NEW_URI, 0)).rejects.toThrow(/registry returns/);
  });
});
