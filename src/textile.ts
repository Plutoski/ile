import { toHex, type Address, type Hex, type LocalAccount } from "viem";
import { CHAIN_ID, TEXTILE } from "./config.js";

export interface TxRequest { to: Address; data: Hex; value: string; chainId: number }

export interface FirmQuote {
  rfqId: string;
  claimToken: string;
  quote: {
    sellAmount: string;
    buyAmount: string;
    feeAmount: string;
    takerPays: string;
    rateRay: string;
    expiresAt: string;
    orderDeadline: string;
    reactor: Address;
    taker: Address;
  };
  transactions: { approval: TxRequest; swap: TxRequest };
}

export type QuoteResult =
  | { status: "quoted"; firm: FirmQuote }
  | { status: "no_quote"; reason: string; retryAfterMs?: number; rfqId?: string; claimToken?: string };

export class TextileError extends Error {
  constructor(readonly httpStatus: number, readonly code: string, message: string) {
    super(`Textile ${httpStatus} ${code}: ${message}`);
  }
}

type Fetch = typeof fetch;

/**
 * Proof that the agent controls its wallet (EIP-712 "Textile Taker Control" v1).
 * Free to sign, moves no funds; valid for 60 seconds from issuedAt.
 */
export async function signTakerProof(account: LocalAccount, now = Date.now()) {
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const signature = await account.signTypedData({
    domain: { name: "Textile Taker Control", version: "1", chainId: CHAIN_ID },
    types: {
      TakerControl: [
        { name: "taker", type: "address" },
        { name: "chainId", type: "uint256" },
        { name: "nonce", type: "bytes32" },
        { name: "issuedAt", type: "uint256" },
      ],
    },
    primaryType: "TakerControl",
    message: { taker: account.address, chainId: BigInt(CHAIN_ID), nonce, issuedAt: BigInt(now) },
  });
  return { nonce, issuedAt: now, signature };
}

export class TextileClient {
  constructor(
    private readonly account: LocalAccount,
    private readonly fetchImpl: Fetch = fetch,
    private readonly base = TEXTILE.apiBase,
  ) {}

  private async call<T>(path: string, init: { method: "GET" | "POST"; body?: unknown; claim?: string; timeoutMs?: number }): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: init.method,
      headers: {
        "content-type": "application/json",
        ...(init.claim ? { "X-Rfq-Claim": init.claim } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
    });
    const text = await res.text();
    let json: { data?: T; error?: { code?: string; message?: string } } = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON error body */ }
    if (!res.ok) {
      throw new TextileError(res.status, json.error?.code ?? "http_error", json.error?.message ?? text.slice(0, 200));
    }
    if (json.data === undefined) throw new TextileError(res.status, "bad_response", "response has no data field");
    return json.data;
  }

  /** Indicative price only: nothing is reserved or signed. Used for dry runs. */
  async preview(p: { sellToken: Address; buyToken: Address; buyAmount: bigint }) {
    return this.call<{ status: string; sellAmount?: string; buyAmount?: string; feeAmount?: string; takerPays?: string }>(
      "/rfq/preview",
      { method: "POST", body: { chainId: CHAIN_ID, sellToken: p.sellToken, buyToken: p.buyToken, buyAmount: p.buyAmount.toString() } },
    );
  }

  /**
   * Ask makers for a firm quote that delivers exactly `buyAmount` of `buyToken`.
   * Always sends a fresh proof of control, so there is no 401 round trip.
   */
  async requestQuote(p: { sellToken: Address; buyToken: Address; buyAmount: bigint }): Promise<QuoteResult> {
    const body = {
      chainId: CHAIN_ID,
      sellToken: p.sellToken,
      buyToken: p.buyToken,
      buyAmount: p.buyAmount.toString(),
      taker: this.account.address,
      takerProof: await signTakerProof(this.account),
    };
    const data = await this.call<Record<string, unknown>>("/rfq/request", {
      method: "POST", body, timeoutMs: TEXTILE.requestTimeoutMs,
    });
    if (data.status === "quoted") return { status: "quoted", firm: data as unknown as FirmQuote };
    return {
      status: "no_quote",
      reason: String(data.reason ?? data.status ?? "unknown"),
      retryAfterMs: typeof data.retryAfterMs === "number" ? data.retryAfterMs : undefined,
      rfqId: data.rfqId as string | undefined,
      claimToken: data.claimToken as string | undefined,
    };
  }

  /** Release a quote we decided not to take, so the makers' inventory is freed. */
  async cancel(rfqId: string, claimToken: string): Promise<void> {
    await this.call(`/rfq/${rfqId}/cancel`, { method: "POST", claim: claimToken });
  }

  /** Report the broadcast swap. Optional for settlement; retried once on failure. */
  async submit(rfqId: string, claimToken: string, txHash: Hex): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.call(`/rfq/${rfqId}/submit`, { method: "POST", body: { txHash }, claim: claimToken });
        return;
      } catch (err) {
        if (attempt === 1) throw err;
      }
    }
  }
}
