import { getAddress, isAddress, type Address } from "viem";

export type Schedule =
  | { kind: "monthly"; day: number }
  | { kind: "once"; date: string }; // YYYY-MM-DD, Lagos time

export interface Recipient {
  id: string;
  name: string;
  relation: string;
  address: Address;
}

export interface Bill {
  id: string;
  label: string;
  category: string;
  recipientId: string;
  /** Whole naira. The recipient receives exactly this amount of cNGN. */
  amountNgn: number;
  schedule: Schedule;
  active: boolean;
}

export interface Policy {
  /** Hard cap on USD₮ spent for one bill, fee included. */
  maxUsdtPerPayout: number;
  /** Hard cap on USD₮ spent across all bills in one calendar month (Lagos time). */
  maxUsdtPerMonth: number;
  /**
   * Worst acceptable rate, as a percentage below the mid-market USD/NGN
   * reference. A quote further below the reference is refused.
   */
  maxSpreadPct: number;
}

export interface Household {
  name: string;
  sender: string;
  recipients: Recipient[];
  bills: Bill[];
  policy: Policy;
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse and validate household.json. Throws one error listing every problem found. */
export function parseHousehold(raw: unknown): Household {
  const errors: string[] = [];
  const o = raw as Partial<Household> | null;
  if (!o || typeof o !== "object") throw new Error("household: expected a JSON object");

  if (typeof o.name !== "string" || !o.name) errors.push("name is required");
  if (typeof o.sender !== "string" || !o.sender) errors.push("sender is required");

  const recipients: Recipient[] = [];
  const recipientIds = new Set<string>();
  for (const [i, r] of (Array.isArray(o.recipients) ? o.recipients : []).entries()) {
    const where = `recipients[${i}]`;
    if (!r || typeof r.id !== "string" || !ID.test(r.id)) errors.push(`${where}.id must be lowercase letters, digits or dashes`);
    else if (recipientIds.has(r.id)) errors.push(`${where}.id "${r.id}" is duplicated`);
    if (!r || typeof r.name !== "string" || !r.name) errors.push(`${where}.name is required`);
    if (!r || typeof r.address !== "string" || !isAddress(r.address)) errors.push(`${where}.address is not a valid address`);
    if (r && typeof r.id === "string" && typeof r.address === "string" && isAddress(r.address)) {
      recipientIds.add(r.id);
      recipients.push({ id: r.id, name: r.name, relation: r.relation ?? "", address: getAddress(r.address) });
    }
  }
  if (recipients.length === 0) errors.push("at least one recipient is required");

  const bills: Bill[] = [];
  const billIds = new Set<string>();
  for (const [i, b] of (Array.isArray(o.bills) ? o.bills : []).entries()) {
    const where = `bills[${i}]`;
    if (!b || typeof b.id !== "string" || !ID.test(b.id)) { errors.push(`${where}.id must be lowercase letters, digits or dashes`); continue; }
    if (billIds.has(b.id)) errors.push(`${where}.id "${b.id}" is duplicated`);
    billIds.add(b.id);
    if (typeof b.label !== "string" || !b.label) errors.push(`${where}.label is required`);
    if (!recipientIds.has(b.recipientId)) errors.push(`${where}.recipientId "${b.recipientId}" is not a known recipient`);
    if (!Number.isInteger(b.amountNgn) || b.amountNgn <= 0) errors.push(`${where}.amountNgn must be a positive whole number of naira`);
    const s = b.schedule as Schedule | undefined;
    if (s?.kind === "monthly") {
      if (!Number.isInteger(s.day) || s.day < 1 || s.day > 31) errors.push(`${where}.schedule.day must be 1-31`);
    } else if (s?.kind === "once") {
      if (typeof s.date !== "string" || !DATE.test(s.date) || Number.isNaN(Date.parse(s.date))) errors.push(`${where}.schedule.date must be YYYY-MM-DD`);
    } else {
      errors.push(`${where}.schedule.kind must be "monthly" or "once"`);
    }
    bills.push({
      id: b.id, label: b.label, category: b.category ?? "other", recipientId: b.recipientId,
      amountNgn: b.amountNgn, schedule: s as Schedule, active: b.active !== false,
    });
  }

  const p = o.policy as Partial<Policy> | undefined;
  const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
  if (!p || !positive(p.maxUsdtPerPayout)) errors.push("policy.maxUsdtPerPayout must be a positive number");
  if (!p || !positive(p.maxUsdtPerMonth)) errors.push("policy.maxUsdtPerMonth must be a positive number");
  if (!p || typeof p.maxSpreadPct !== "number" || p.maxSpreadPct < 0 || p.maxSpreadPct > 20) errors.push("policy.maxSpreadPct must be between 0 and 20");
  if (p && positive(p.maxUsdtPerPayout) && positive(p.maxUsdtPerMonth) && p.maxUsdtPerPayout! > p.maxUsdtPerMonth!) {
    errors.push("policy.maxUsdtPerPayout cannot exceed policy.maxUsdtPerMonth");
  }

  if (errors.length) throw new Error(`household.json is invalid:\n  - ${errors.join("\n  - ")}`);
  return { name: o.name!, sender: o.sender!, recipients, bills, policy: p as Policy };
}

// ---- Time (Lagos is UTC+1 all year, no daylight saving) ----

const LAGOS_OFFSET_MS = 60 * 60 * 1000;

/** Calendar date in Lagos as YYYY-MM-DD. */
export function lagosDate(now: Date): string {
  return new Date(now.getTime() + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
}

/** Calendar month in Lagos as YYYY-MM. */
export function lagosMonth(now: Date): string {
  return lagosDate(now).slice(0, 7);
}

function daysInMonth(yyyymm: string): number {
  const [y, m] = yyyymm.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The period a payment belongs to: the month for monthly bills, "once" for one-off bills. */
export function periodOf(bill: Bill, now: Date): string {
  return bill.schedule.kind === "monthly" ? lagosMonth(now) : "once";
}

/** Due date (YYYY-MM-DD) of the bill in the period containing `now`. Day 31 becomes the month's last day. */
export function dueDateOf(bill: Bill, now: Date): string {
  if (bill.schedule.kind === "once") return bill.schedule.date;
  const month = lagosMonth(now);
  const day = Math.min(bill.schedule.day, daysInMonth(month));
  return `${month}-${String(day).padStart(2, "0")}`;
}

/** A bill is due once its due date has arrived in Lagos and it has not been settled for this period. */
export function isDue(bill: Bill, now: Date, settled: (billId: string, period: string) => boolean): boolean {
  if (!bill.active) return false;
  if (lagosDate(now) < dueDateOf(bill, now)) return false;
  return !settled(bill.id, periodOf(bill, now));
}
