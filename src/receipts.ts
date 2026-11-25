import { erc20Abi, getAddress, parseEventLogs, type Address, type Log } from "viem";

/**
 * When gas is paid in a stablecoin, Celo debits and refunds it through this
 * system address. Those transfers are gas, not part of the swap.
 */
export const FEE_DEBIT_ADDRESS: Address = "0x000000000000000000000000000000000Ce106A5";

export interface TokenFlows {
  /** Total of `token` the agent received in this transaction. */
  received: bigint;
  /** Total of `token` the agent sent, excluding gas debits. */
  sent: bigint;
  /** Who sent the agent `token`, and who the agent sent it to (gas excluded). */
  from: Address[];
  to: { address: Address; amount: bigint }[];
}

/**
 * Read token movements straight from a transaction's logs. This is the
 * source of truth for what a transaction did: a balance read just after
 * confirmation can come from a node that is a block behind.
 */
export function tokenFlows(logs: Log[], token: Address, agent: Address): TokenFlows {
  const tok = getAddress(token);
  const me = getAddress(agent);
  const flows: TokenFlows = { received: 0n, sent: 0n, from: [], to: [] };
  for (const t of parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs })) {
    if (getAddress(t.address) !== tok) continue;
    const from = getAddress(t.args.from);
    const to = getAddress(t.args.to);
    if (to === me && from !== FEE_DEBIT_ADDRESS) { flows.received += t.args.value; flows.from.push(from); }
    if (from === me && to !== FEE_DEBIT_ADDRESS) { flows.sent += t.args.value; flows.to.push({ address: to, amount: t.args.value }); }
  }
  return flows;
}
