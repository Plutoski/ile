import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { formatUnits, isHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { makeChain, makePublicClient } from "./chain.js";
import { AGENT_ADDRESS, EXPLORER_TX, TOKENS, USDT_DECIMALS } from "./config.js";
import { dueDateOf, isDue, lagosDate, lagosMonth, parseHousehold, periodOf, type Household } from "./household.js";
import { adoptSwap } from "./adopt.js";
import { registerAgent, setAgentURI } from "./identity.js";
import { isSettled, loadLedger, mergeLedgers, saveLedger, usdtSpentInMonth } from "./ledger.js";
import { payBill } from "./payout.js";
import { checkPrice, fmtUsdt } from "./policy.js";
import { fetchReferenceRate } from "./rate.js";
import { TextileClient } from "./textile.js";
import { renderPage, type Identity } from "./render.js";
import { verifyLedger } from "./verify.js";

const env = (k: string, d?: string) => process.env[k] ?? d;
const HOUSEHOLD_FILE = env("HOUSEHOLD_FILE", "household.json")!;
const LEDGER_FILE = env("LEDGER_FILE", "data/ledger.json")!;
const IDENTITY_FILE = env("IDENTITY_FILE", "data/identity.json")!;
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function household(): Promise<Household> {
  const text = await readFile(HOUSEHOLD_FILE, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") throw new Error(`${HOUSEHOLD_FILE} not found; copy household.example.json and fill in your recipients and bills`);
    throw e;
  });
  return parseHousehold(JSON.parse(text));
}

function account() {
  const key = env("AGENT_PRIVATE_KEY");
  if (!key) throw new Error("AGENT_PRIVATE_KEY is not set");
  const hex = (key.startsWith("0x") ? key : `0x${key}`) as Hex;
  if (!isHex(hex) || hex.length !== 66) throw new Error("AGENT_PRIVATE_KEY is not a 32-byte hex key");
  const acct = privateKeyToAccount(hex);
  if (acct.address !== AGENT_ADDRESS) {
    throw new Error(`AGENT_PRIVATE_KEY belongs to ${acct.address}, not the agent wallet ${AGENT_ADDRESS}. Check the repo secret.`);
  }
  return acct;
}

async function householdIfPresent(): Promise<Household | null> {
  try { return await household(); } catch (e) {
    if ((e as Error).message.includes("not found")) return null;
    throw e;
  }
}

function chainFor() {
  return makeChain({ account: account(), rpcUrl: env("RPC_URL"), gasInUsdt: env("GAS_IN_USDT") === "true" });
}

/** Count a transaction the agent sent outside a payment, so the stale-ledger guard does not mistake it for a lost one. */
async function noteSent(chain: ReturnType<typeof chainFor>, nonceAfter: number) {
  const ledger = await loadLedger(LEDGER_FILE);
  if (ledger.lastNonce === undefined) return; // not armed yet; the next payment arms it
  ledger.lastNonce = Math.max(ledger.lastNonce, nonceAfter);
  await saveLedger(LEDGER_FILE, ledger);
}

async function openLedger(agent: `0x${string}`) {
  await mkdir(dirname(LEDGER_FILE), { recursive: true });
  const ledger = await loadLedger(LEDGER_FILE);
  if (ledger.agent && ledger.agent.toLowerCase() !== agent.toLowerCase()) {
    throw new Error(`ledger belongs to ${ledger.agent}, but the key is for ${agent}. One wallet for the whole event.`);
  }
  ledger.agent = agent;
  return { ledger, persist: () => saveLedger(LEDGER_FILE, ledger) };
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
  /** Balances, schedule and what is due today. Read-only. */
  async status() {
    const h = await householdIfPresent();
    const chain = chainFor();
    const { ledger } = await openLedger(chain.agent);
    const now = new Date();
    const [usdt, cngn, celo, dec] = await Promise.all([
      chain.balance(TOKENS.USDT), chain.balance(TOKENS.CNGN),
      chain.publicClient.getBalance({ address: chain.agent }), chain.decimals(TOKENS.CNGN),
    ]);
    console.log(`Agent      ${chain.agent}`);
    console.log(`Balances   ${formatUnits(usdt, USDT_DECIMALS)} USD₮ · ${formatUnits(cngn, dec)} cNGN · ${formatUnits(celo, 18)} CELO`);
    console.log(`Today      ${lagosDate(now)} (Lagos)`);
    if (!h) return console.log(`\nNo ${HOUSEHOLD_FILE} yet: the wallet works, there is just nothing to pay.`);
    console.log(`This month ${fmtUsdt(usdtSpentInMonth(ledger, now))} / ${h.policy.maxUsdtPerMonth} USD₮ spent\n`);
    for (const b of h.bills) {
      const state = isSettled(ledger)(b.id, periodOf(b, now)) ? "paid" : isDue(b, now, isSettled(ledger)) ? "DUE" : "upcoming";
      console.log(`  ${state.padEnd(8)} ${b.id.padEnd(20)} ₦${b.amountNgn.toLocaleString("en-NG").padEnd(10)} due ${dueDateOf(b, now)}  ${b.label}`);
    }
  },

  /** Pay every bill that is due. --dry-run prices them with a free preview and moves nothing. */
  async run(args) {
    const dry = args.includes("--dry-run");
    const h = await householdIfPresent();
    if (!h) return log(`no ${HOUSEHOLD_FILE} yet; nothing to pay`);
    const chain = chainFor();
    const { ledger, persist } = await openLedger(chain.agent);
    const now = new Date();
    const textile = new TextileClient(account());

    // Dry run: price every unpaid bill with Textile's free preview. Moves nothing, reserves nothing.
    if (dry) {
      const unpaid = h.bills.filter((b) => b.active && !isSettled(ledger)(b.id, periodOf(b, now)));
      const [dec, ref] = await Promise.all([chain.decimals(TOKENS.CNGN), fetchReferenceRate()]);
      log(`dry run: pricing ${unpaid.length} unpaid bill(s); official rate ${ref ? `₦${ref.rate.toFixed(2)}/$ from ${ref.sources.map((s) => s.name).join(" + ")}` : "unavailable"}`);
      // Bills due in the same Lagos month share its cap, so count each one the dry run would pay.
      const committed = new Map<string, bigint>([[lagosMonth(now), usdtSpentInMonth(ledger, now)]]);
      for (const b of unpaid) {
        const month = dueDateOf(b, now).slice(0, 7);
        const p = await textile.preview({ sellToken: TOKENS.USDT, buyToken: TOKENS.CNGN, buyAmount: BigInt(b.amountNgn) * 10n ** BigInt(dec) });
        if (p.status !== "preview" || !p.takerPays) { log(`  ${b.id}: no price (${p.status})`); continue; }
        const cost = BigInt(p.takerPays);
        // The same money rules a live payment must pass, monthly cap included.
        const v = checkPrice({
          takerPays: cost, cngnAtomic: BigInt(b.amountNgn) * 10n ** BigInt(dec), cngnDecimals: dec,
          policy: h.policy, spentThisMonth: committed.get(month) ?? 0n, referenceRate: ref?.rate ?? null,
        });
        if (v.ok) committed.set(month, (committed.get(month) ?? 0n) + cost);
        const verdict = v.ok
          ? `would pay at ₦${v.rate.toFixed(2)}/$${v.spreadPct === null ? "" : ` (${v.spreadPct <= 0 ? "+" : "-"}${Math.abs(v.spreadPct).toFixed(2)}% vs official)`}`
          : `REFUSE: ${v.reason}`;
        log(`  ${b.id.padEnd(20)} ₦${b.amountNgn} ≈ ${fmtUsdt(cost)} USD₮ → ${verdict}`);
      }
      return;
    }

    // Due bills, plus any bill whose naira was bought but not yet delivered, whatever its period.
    const due = h.bills.filter((b) => isDue(b, now, isSettled(ledger))
      || ledger.payments.some((p) => p.billId === b.id && p.status === "swapped"));
    log(`${due.length} bill(s) due on ${lagosDate(now)}`);
    if (due.length === 0) return persist();
    let failures = 0;
    for (const b of due) {
      const out = await payBill(b, h, { chain, textile, reference: fetchReferenceRate, ledger, persist, log });
      if (out.kind === "failed") failures++;
    }
    if (failures) process.exitCode = 1;
  },

  /**
   * Pay one bill now, even before its due date. Caps, rate checks and double-pay protection still apply.
   * Usage: pay <billId>, or pay <billId>:<swapTxHash> to adopt an unrecorded swap first.
   */
  async pay(args) {
    // "billId:swapTxHash" first records a swap the agent completed but could not record, then delivers it.
    const [billId, swapHash] = (args[0] ?? "").split(":");
    if (swapHash) await commands.adopt!([billId!, swapHash]);
    if (!billId) throw new Error("usage: pay <billId> or pay <billId>:<swapTxHash>");
    const h = await household();
    const bill = h.bills.find((b) => b.id === billId);
    if (!bill) throw new Error(`no bill "${billId}" in ${HOUSEHOLD_FILE}`);
    const chain = chainFor();
    const { ledger, persist } = await openLedger(chain.agent);
    const out = await payBill(bill, h, { chain, textile: new TextileClient(account()), reference: fetchReferenceRate, ledger, persist, log });
    if (out.kind === "failed") process.exitCode = 1;
  },

  /**
   * Record a completed swap the agent could not record itself, after checking it onchain.
   * Usage: adopt <billId> <swapTxHash>  (or "billId:swapTxHash" as one argument)
   */
  async adopt(args) {
    const [billId, hash] = args.length === 1 ? args[0]!.split(/[:\s]+/) : args;
    if (!billId || !hash?.match(/^0x[0-9a-fA-F]{64}$/)) throw new Error("usage: adopt <billId> <swapTxHash>");
    const h = await household();
    const bill = h.bills.find((b) => b.id === billId);
    if (!bill) throw new Error(`no bill "${billId}" in ${HOUSEHOLD_FILE}`);
    const chain = chainFor();
    const { ledger, persist } = await openLedger(chain.agent);
    const [tx, receipt, dec] = await Promise.all([
      chain.publicClient.getTransaction({ hash: hash as `0x${string}` }),
      chain.publicClient.getTransactionReceipt({ hash: hash as `0x${string}` }),
      chain.decimals(TOKENS.CNGN),
    ]);
    const payment = adoptSwap({
      ledger, household: h, bill, agent: chain.agent, cngnDecimals: dec, now: new Date(),
      swap: { hash: tx.hash, from: tx.from, to: tx.to, input: tx.input, status: receipt.status, logs: receipt.logs },
    });
    await persist();
    log(`adopted swap for ${bill.id}: ₦${payment.amountNgn} bought for ${fmtUsdt(BigInt(payment.usdtSpent))} USD₮; run "pay ${bill.id}" to deliver it`);
  },

  /** Register the agent's ERC-8004 identity from the agent wallet. */
  async register([agentURI]) {
    if (!agentURI?.startsWith("https://")) throw new Error("usage: register <https URL of agent.json>");
    const chain = chainFor();
    try {
      const existing = JSON.parse(await readFile(IDENTITY_FILE, "utf8"));
      throw new Error(`already registered as agent #${existing.agentId} (${IDENTITY_FILE})`);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const { agentId, hash } = await registerAgent(chain, agentURI);
    await noteSent(chain, await chain.sentCount());
    await mkdir(dirname(IDENTITY_FILE), { recursive: true });
    await writeFile(IDENTITY_FILE, JSON.stringify({ agentId: agentId.toString(), owner: chain.agent, agentURI, registerTx: hash }, null, 2) + "\n");
    log(`registered agent #${agentId}: ${EXPLORER_TX(hash)}`);
  },

  /** Point the registered ERC-8004 identity at a new agent card URL. Safe to rerun. */
  async "set-uri"([agentURI]) {
    if (!agentURI?.startsWith("https://")) throw new Error("usage: set-uri <https URL of agent.json>");
    const identity = JSON.parse(await readFile(IDENTITY_FILE, "utf8"));
    const chain = chainFor();
    const { hash } = await setAgentURI(chain, BigInt(identity.agentId), agentURI);
    if (!hash) {
      // Already set on chain, perhaps by an earlier run that stopped before saving. Keep the file in step.
      if (identity.agentURI !== agentURI) await writeFile(IDENTITY_FILE, JSON.stringify({ ...identity, agentURI }, null, 2) + "\n");
      log(`agent #${identity.agentId} already points to ${agentURI}`);
      return;
    }
    await noteSent(chain, await chain.sentCount());
    await writeFile(IDENTITY_FILE, JSON.stringify({ ...identity, agentURI, uriTx: hash }, null, 2) + "\n");
    log(`agent #${identity.agentId} now points to ${agentURI}: ${EXPLORER_TX(hash)}`);
  },

  /** Combine two copies of the ledger into data/ledger.json, losing nothing either recorded. Needs no key. */
  async "merge-ledger"([upstream, mine]) {
    if (!upstream || !mine) throw new Error("usage: merge-ledger <upstream.json> <mine.json>");
    const merged = mergeLedgers(await loadLedger(upstream), await loadLedger(mine));
    await saveLedger(LEDGER_FILE, merged);
    log(`merged ledgers: ${merged.payments.length} payments, ${merged.decisions.length} decisions`);
  },

  /** Write the current figures into docs/index.html so it reads right without JavaScript. Needs no key. */
  async render() {
    const page = "docs/index.html";
    const identity = await readFile(IDENTITY_FILE, "utf8").then((t) => JSON.parse(t) as Identity).catch(() => null);
    const html = renderPage(await readFile(page, "utf8"), await household(), await loadLedger(LEDGER_FILE), identity, new Date());
    await writeFile(page, html);
    log(`rendered ${page}`);
  },

  /** Check every ledger transaction against the chain. Needs no key. */
  async verify() {
    const ledger = await loadLedger(LEDGER_FILE);
    const checks = await verifyLedger(makePublicClient(env("RPC_URL")), ledger);
    for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.billId.padEnd(20)} ${c.step.padEnd(9)} ${c.hash}${c.ok ? "" : `  ${c.problems.join("; ")}`}`);
    const bad = checks.filter((c) => !c.ok).length;
    console.log(`\n${checks.length - bad}/${checks.length} transactions verified onchain`);
    if (bad) process.exitCode = 1;
  },
};

const [cmd, ...rest] = process.argv.slice(2);
const fn = cmd ? commands[cmd] : undefined;
if (!fn) {
  console.error(`usage: npm run agent -- <${Object.keys(commands).join("|")}> [args]`);
  process.exit(2);
}
fn(rest).catch((err) => {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
});
