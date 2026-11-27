import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { emptyLedger, type Payment } from "../src/ledger.js";
import { renderPage, setInner } from "../src/render.js";
import { household, MUM } from "./fixtures.js";

const NOW = new Date("2026-11-30T10:00:00Z");
const paid = (billId: string, at: string): Payment => ({
  billId, period: billId === "light" ? "2026-11" : "once", recipientId: "mum", recipient: MUM, amountNgn: 2000,
  usdtSpent: "1400000", usdtFee: "280", cngnAmount: "2000000000", rate: 1428.57, referenceRate: 1400, rfqId: "q",
  txs: { swap: `0x${"a".repeat(64)}`, transfer: `0x${"b".repeat(64)}` }, status: "paid", createdAt: at, updatedAt: at,
});

describe("writing the figures into the page", () => {
  it("replaces only what is inside the element, even with the same tag nested", () => {
    const html = `<div id="x"><div>old</div></div><div>keep</div>`;
    expect(setInner(html, "x", "new")).toBe(`<div id="x">new</div><div>keep</div>`);
    expect(() => setInner(html, "missing", "")).toThrow(/exactly one element/);
    expect(setInner(`<h1 id="h">a</h1>`, "h", "b")).toBe(`<h1 id="h">b</h1>`);
  });

  it("refuses markup it could splice wrongly instead of corrupting the page", () => {
    expect(() => setInner(`<p id="x" title="a>b">old</p>`, "x", "")).toThrow(/exactly one/);
    expect(() => setInner(`<p data-id="x">a</p><p class="c" data-id="x">b</p>`, "x", "")).toThrow(/exactly one/);
    expect(() => setInner(`<p id="x"><!-- </p> -->old</p>`, "x", "")).toThrow(/comment/);
  });

  it("shows the real figures, proof links and early payment, and is stable when run again", async () => {
    const page = await readFile("docs/index.html", "utf8");
    const ledger = { ...emptyLedger(), payments: [paid("light", "2026-11-03T09:00:00Z")] };
    const once = renderPage(page, household(), ledger, { agentId: "10136" }, NOW);
    expect(once).toContain(`<dd id="f-count">1 of 2</dd>`);
    expect(once).toContain("₦</span>2,000</p>");
    expect(once).toContain("Paid early");
    expect(once).toContain(`/tx/0x${"b".repeat(64)}" rel="noopener">Delivered to Mum`);
    expect(once).toContain("0.02% of the dollars spent");
    expect(renderPage(once, household(), ledger, { agentId: "10136" }, NOW)).toBe(once);
  });

  it("escapes household text, so a name cannot inject markup", async () => {
    const page = await readFile("docs/index.html", "utf8");
    const h = household();
    h.recipients[0]!.name = `<img src=x onerror=alert(1)>`;
    const html = renderPage(page, h, emptyLedger(), null, NOW);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
