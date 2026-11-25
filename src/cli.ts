import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { formatUnits, isHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { makeChain, makePublicClient } from "./chain.js";
import { EXPLORER_TX, TOKENS, USDT_DECIMALS } from "./config.js";
import { dueDateOf, isDue, lagosDate, parseHousehold, periodOf, type Household } from "./household.js";
import { registerAgent } from "./identity.js";
import { isSettled, loadLedger, saveLedger, usdtSpentInMonth } from "./ledger.js";
import { payBill } from "./payout.js";
import { fmtUsdt } from "./policy.js";
import { fetchReferenceRate } from "./rate.js";
import { TextileClient } from "./textile.js";
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
  return privateKeyToAccount(hex);
}

function chainFor() {
  return makeChain({ account: account(), rpcUrl: env("RPC_URL"), gasInUsdt: env("GAS_IN_USDT") === "true" });
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
    const h = await household();
    const chain = chainFor();
    const { ledger } = await openLedger(chain.agent);
    const now = new Date();
    const [usdt, cngn, celo, dec] = await Promise.all([
      chain.balance(TOKENS.USDT), chain.balance(TOKENS.CNGN),
      chain.publicClient.getBalance({ address: chain.agent }), chain.decimals(TOKENS.CNGN),
    ]);
    console.log(`Agent      ${chain.agent}`);
    console.log(`Balances   ${formatUnits(usdt, USDT_DECIMALS)} USD₮ · ${formatUnits(cngn, dec)} cNGN · ${formatUnits(celo, 18)} CELO`);
    console.log(`This month ${fmtUsdt(usdtSpentInMonth(ledger, now))} / ${h.policy.maxUsdtPerMonth} USD₮ spent`);
    console.log(`Today      ${lagosDate(now)} (Lagos)\n`);
    for (const b of h.bills) {
      const state = isSettled(ledger)(b.id, periodOf(b, now)) ? "paid" : isDue(b, now, isSettled(ledger)) ? "DUE" : "upcoming";
      console.log(`  ${state.padEnd(8)} ${b.id.padEnd(20)} ₦${b.amountNgn.toLocaleString("en-NG").padEnd(10)} due ${dueDateOf(b, now)}  ${b.label}`);
    }
  },

  /** Pay every bill that is due. --dry-run prices them with a free preview and moves nothing. */
  async run(args) {
    const dry = args.includes("--dry-run");
    const h = await household();
    const chain = chainFor();
    const { ledger, persist } = await openLedger(chain.agent);
    const now = new Date();
    const due = h.bills.filter((b) => isDue(b, now, isSettled(ledger)));
    log(`${due.length} bill(s) due on ${lagosDate(now)}${dry ? " (dry run)" : ""}`);
    if (due.length === 0) return persist();

    const textile = new TextileClient(account());
    if (dry) {
      const dec = await chain.decimals(TOKENS.CNGN);
      const ref = await fetchReferenceRate();
      for (const b of due) {
        const p = await textile.preview({ sellToken: TOKENS.USDT, buyToken: TOKENS.CNGN, buyAmount: BigInt(b.amountNgn) * 10n ** BigInt(dec) });
        log(`${b.id}: ₦${b.amountNgn} would cost ~${p.takerPays ? fmtUsdt(BigInt(p.takerPays)) : "?"} USD₮ (${p.status}); mid-market ₦${ref?.rate.toFixed(2) ?? "n/a"}/$`);
      }
      return;
    }
    let failures = 0;
    for (const b of due) {
      const out = await payBill(b, h, { chain, textile, reference: fetchReferenceRate, ledger, persist, log });
      if (out.kind === "failed") failures++;
    }
    if (failures) process.exitCode = 1;
  },

  /** Pay one bill now, even before its due date. Caps, rate checks and double-pay protection still apply. */
  async pay([billId]) {
    if (!billId) throw new Error("usage: pay <billId>");
    const h = await household();
    const bill = h.bills.find((b) => b.id === billId);
    if (!bill) throw new Error(`no bill "${billId}" in ${HOUSEHOLD_FILE}`);
    const chain = chainFor();
    const { ledger, persist } = await openLedger(chain.agent);
    const out = await payBill(bill, h, { chain, textile: new TextileClient(account()), reference: fetchReferenceRate, ledger, persist, log });
    if (out.kind === "failed") process.exitCode = 1;
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
    await mkdir(dirname(IDENTITY_FILE), { recursive: true });
    await writeFile(IDENTITY_FILE, JSON.stringify({ agentId: agentId.toString(), owner: chain.agent, agentURI, registerTx: hash }, null, 2) + "\n");
    log(`registered agent #${agentId}: ${EXPLORER_TX(hash)}`);
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
