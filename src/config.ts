import type { Address } from "viem";

/**
 * Fixed onchain facts for Celo mainnet. Every address here is checked
 * against the official sources listed next to it; the agent refuses to
 * approve or call anything that is not in this file.
 */
export const CHAIN_ID = 42220;

/** Loops House "Agents Open for Business" attribution code for this entry. */
export const ATTRIBUTION_CODE = "celo_10e86a43fdc3";

export const TOKENS = {
  // fx-docs.textilecredit.com/protocol/address-book, loops.house event page
  USDT: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
  CNGN: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f",
} as const satisfies Record<string, Address>;

/** USD₮ has 6 decimals on Celo. */
export const USDT_DECIMALS = 6;

export const TEXTILE = {
  apiBase: "https://api.textilecredit.com/v2",
  // The only contract the agent will ever approve to pull USD₮.
  reactor: "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3",
  // Server may block up to ~70s while makers answer; docs ask for 75s.
  requestTimeoutMs: 75_000,
  // Never broadcast a swap this close to (or past) the quote's expiresAt.
  expirySafetyMs: 4_000,
} as const;

export const ERC8004 = {
  // docs.celo.org/build-on-celo/build-with-ai/8004
  identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
} as const satisfies Record<string, Address>;

/** Fee-abstraction adapter: pays gas in USD₮ instead of CELO (docs.celo.org fee currencies). */
export const USDT_FEE_ADAPTER: Address = "0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72";

export const DEFAULT_RPC_URL = "https://forno.celo.org";

export const EXPLORER_TX = (hash: string) => `https://celoscan.io/tx/${hash}`;
