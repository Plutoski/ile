/**
 * Mid-market USD -> NGN reference used to judge Textile quotes.
 * Two free public sources: when both answer, the agent uses their average,
 * and trusts neither if they disagree by more than 5%.
 */
type Fetch = typeof fetch;

export interface ReferenceRate { rate: number; sources: { name: string; rate: number }[] }

const SOURCES: { name: string; url: string; pick: (j: any) => unknown }[] = [
  { name: "open.er-api.com", url: "https://open.er-api.com/v6/latest/USD", pick: (j) => j?.rates?.NGN },
  { name: "fawazahmed0/currency-api", url: "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json", pick: (j) => j?.usd?.ngn },
];

export async function fetchReferenceRate(fetchImpl: Fetch = fetch): Promise<ReferenceRate | null> {
  const results = await Promise.all(
    SOURCES.map(async (s) => {
      try {
        const res = await fetchImpl(s.url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return null;
        const rate = Number(s.pick(await res.json()));
        return Number.isFinite(rate) && rate > 100 && rate < 100_000 ? { name: s.name, rate } : null;
      } catch {
        return null;
      }
    }),
  );
  const ok = results.filter((r): r is { name: string; rate: number } => r !== null);
  if (ok.length === 0) return null;
  const [a, b] = ok;
  if (a && b) {
    if (Math.abs(a.rate - b.rate) / Math.min(a.rate, b.rate) > 0.05) return null; // sources disagree: trust neither
    return { rate: (a.rate + b.rate) / 2, sources: ok };
  }
  return a ? { rate: a.rate, sources: ok } : null;
}
