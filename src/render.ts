import { dueDateOf, lagosDate, periodOf, type Household } from "./household.js";
import type { Ledger, Payment } from "./ledger.js";

/**
 * Writes the current figures into docs/index.html, so the page reads correctly without JavaScript
 * (search engines, link previews, review bots). The page's own script redraws the same parts on load.
 * Only the inside of elements with these ids changes; the rest of the file is left byte for byte.
 */

const CELOSCAN = "https://celoscan.io";
const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

export interface Identity { agentId?: string }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const ngn = (n: number) => "₦" + Math.round(n).toLocaleString("en-NG");
const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);
const nb = (t: string) => t.replace(/-/g, "‑");
const link = (href: string, text: string) => `<a href="${esc(href)}" rel="noopener">${esc(text)}</a>`;
const dayMonth = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Replace what is inside the element with this id. Throws if the page no longer has it. */
export function setInner(html: string, id: string, inner: string): string {
  // The id must be the opening tag's last attribute, so the tag's end is the next ">".
  const found = [...html.matchAll(new RegExp(`<([a-z0-9]+)(?:\\s[^<>]*)?\\sid="${id}">`, "g"))];
  if (found.length !== 1) throw new Error(`docs/index.html needs exactly one element ending its tag with id="${id}", found ${found.length}`);
  const tag = found[0]![1]!;
  const start = found[0]!.index! + found[0]![0].length;
  let depth = 1;
  const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, "g");
  re.lastIndex = start;
  if (html.slice(start, html.indexOf(`</${tag}>`, start)).includes("<!--")) throw new Error(`element "${id}" contains a comment; remove it`);
  for (let m; (m = re.exec(html)); ) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(0, start) + inner + html.slice(m.index);
  }
  throw new Error(`element "${id}" in docs/index.html is never closed`);
}

export function renderPage(html: string, household: Household, ledger: Ledger, identity: Identity | null, now: Date): string {
  const all = ledger.payments;
  const payments = all.filter((p) => p.status === "paid").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const bills = household.bills.filter((b) => b.active);
  const person = (id: string) => household.recipients.find((r) => r.id === id);
  const paymentOf = (id: string, period: string): Payment | undefined =>
    all.find((p) => p.billId === id && p.period === period && p.status === "paid");
  const shown = bills.map((b) => {
    const paid = paymentOf(b.id, periodOf(b, now));
    const due = dueDateOf(b, now);
    return { b, paid, due, date: paid ? lagosDate(new Date(paid.updatedAt)) : due };
  }).sort((x, y) => x.date.localeCompare(y.date));
  const next = shown.find((s) => !s.paid);

  const totalNgn = payments.reduce((s, p) => s + p.amountNgn, 0);
  const usd = payments.reduce((s, p) => s + Number(p.usdtSpent) / 1e6, 0);
  const fees = payments.reduce((s, p) => s + Number(p.usdtFee) / 1e6, 0);
  const cost = usd > 0 ? ` Textile's fee was $${fees.toFixed(4)}, ${(fees / usd * 100).toFixed(2)}% of the dollars spent.` : "";

  const sender = /^([^(]+)\(([^)]+)\)/.exec(household.sender);
  const family = household.name.replace(/,.*$/, "").replace(/^The /, "the ");
  if (sender) {
    html = setInner(html, "headline", `<strong>Ilé</strong> is an agent that pays ${esc(family)}'s bills in Nigeria. It swaps dollars ${esc(sender[1]!.trim())} holds in ${esc(sender[2]!)} for naira on Textile FX and sends each bill on Celo.`);
  }
  html = setInner(html, "f-ngn", `<span class="cur">₦</span>${Math.round(totalNgn).toLocaleString("en-NG")}`);
  const nextWho = next ? person(next.b.recipientId)?.name ?? "the family" : "";
  html = setInner(html, "f-note", next
    ? `delivered so far.${esc(cost)} Next is <b>${esc(next.b.label.toLowerCase())} for ${esc(nextWho)}</b> on ${dayMonth(next.due)}.`
    : `delivered. Every bill this cycle is paid.${esc(cost)}`);

  const agentNo = identity?.agentId ?? "10136";
  const proof: string[] = [];
  const last = payments[0];
  if (last?.txs.transfer) {
    proof.push(link(`${CELOSCAN}/tx/${last.txs.swap}`, "Swap on Textile"));
    proof.push(link(`${CELOSCAN}/tx/${last.txs.transfer}`, "Delivered to " + (person(last.recipientId)?.name ?? short(last.recipient))));
  }
  proof.push(link(`${CELOSCAN}/nft/${REGISTRY}/${agentNo}`, `ERC-8004 agent #${agentNo}`));
  html = setInner(html, "f-proof", proof.map((a) => `<li>${a}</li>`).join(""));
  html = setInner(html, "f-count", `${shown.filter((s) => s.paid).length} of ${bills.length}`);
  html = setInner(html, "f-usd", `$${usd.toFixed(2)}`);
  if (usd > 0) html = setInner(html, "f-rate", `${ngn(totalNgn / usd)} per $`);

  const stops = shown.map(({ b, paid, due, date }) => {
    const who = person(b.recipientId);
    const cls = paid ? "paid" : b === next?.b ? "next" : "";
    const state = paid ? (date < due ? "Paid early" : "Paid") : b === next?.b ? "Next" : "Scheduled";
    return `<li class="stop ${cls}"><span class="knot" aria-hidden="true"></span><div class="body">`
      + `<span class="when">${dayMonth(date)}</span><span class="what">${esc(nb(b.label))}</span>`
      + `<span class="who">${who ? esc(`${who.name}, ${who.relation}`) : ""}</span></div>`
      + `<div class="side"><span class="amt">${ngn(b.amountNgn)}</span><span class="state">${state}</span></div></li>`;
  });
  html = setInner(html, "timeline", stops.length
    ? `<span class="track" aria-hidden="true"></span>${stops.join("")}`
    : `<li class="stop"><span class="who">The household hasn't been set up yet.</span></li>`);

  const rows = payments.map((p) => {
    const b = bills.find((x) => x.id === p.billId) ?? household.bills.find((x) => x.id === p.billId);
    const who = person(p.recipientId);
    const official = p.referenceRate ? ((p.rate - p.referenceRate) / p.referenceRate) * 100 : null;
    const vs = official === null
      ? (p.rfqId === "recovered-from-chain" ? "recovered from chain" : "official rate not saved")
      : `${official >= 0 ? "+" : ""}${official.toFixed(1)}% vs official`;
    return `<tr><td class="lead" data-label="Paid">${when(p.updatedAt)}</td>`
      + `<td data-label="Bill"><span>${esc(nb(b?.label ?? p.billId))}<span class="sm">to ${esc(who?.name ?? short(p.recipient))}</span></span></td>`
      + `<td class="r" data-label="Naira">${ngn(p.amountNgn)}</td>`
      + `<td class="r" data-label="Cost">$${(Number(p.usdtSpent) / 1e6).toFixed(2)}</td>`
      + `<td class="r" data-label="Rate"><span>${ngn(p.rate)}<span class="sm">${vs}</span></span></td>`
      + `<td class="proof" data-label="Proof"><span>${link(`${CELOSCAN}/tx/${p.txs.swap}`, "Swap")}${p.txs.transfer ? link(`${CELOSCAN}/tx/${p.txs.transfer}`, "Transfer") : ""}</span></td></tr>`;
  });
  html = setInner(html, "book", rows.length ? rows.join("") : `<tr><td class="empty" colspan="6">No payments yet.</td></tr>`);

  const pol = household.policy;
  const rules: [string, string][] = [
    [`No bill costs more than $${pol.maxUsdtPerPayout}`, "Counting Textile's fee. A dearer quote is cancelled."],
    [`No more than $${pol.maxUsdtPerMonth} a month`, "Across every bill in the Lagos calendar month."],
    [`Never more than ${pol.maxSpreadPct}% below the official rate`, "The CBN rate is read from two sources. If they disagree, nothing is paid."],
    ["Only the family's wallets", "Naira goes only to the addresses in the household file."],
    ["Only Textile's contract", "The agent approves and calls Textile's swap contract and nothing else, for the exact amount."],
    ["Never pays twice", "Each step is saved before the next. A run that stops halfway is finished by the next one, not repeated."],
  ];
  html = setInner(html, "rule-list", rules.map(([t, d]) => `<div><dt>${esc(t)}</dt><dd>${esc(d)}</dd></div>`).join(""));
  return html;
}
