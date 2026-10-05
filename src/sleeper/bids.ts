import { round } from "./guillotine.js";
import type { Candidate } from "./projections.js";

/** One resolved FAAB auction. */
export interface AuctionResult {
  week: number;
  winning_bid: number;
  chop_pool: boolean;
}

interface LogNormal {
  mu: number;
  sigma: number;
}

/** Model of the highest bid a newcomer would have to beat: an equal mix of one or more log-normal views. */
export interface PriceModel {
  n: number;
  parts: LogNormal[];
  median: number;
  /** interquartile range */
  low: number;
  high: number;
}

/** Rank 0 is the most-wanted player in a pool. Ranks at or beyond this share one model. */
const LAST_RANK_GROUP = 5;
export const rankGroup = (rank0: number) => Math.min(rank0, LAST_RANK_GROUP);

// Few past chops means few samples, so never let the fit claim more precision than this.
const MIN_SIGMA = 0.3;
const MIN_SIGMA_FEW_SAMPLES = 0.5;
function normCdf(x: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

const cdf = (bid: number, parts: LogNormal[]) =>
  bid <= 0 ? 0 : parts.reduce((s, p) => s + normCdf((Math.log(bid) - p.mu) / p.sigma), 0) / parts.length;

function quantile(q: number, parts: LogNormal[]) {
  let lo = 1;
  let hi = 5000;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid, parts) < q) lo = mid;
    else hi = mid;
  }
  return Math.round((lo + hi) / 2);
}

function makeModel(n: number, parts: LogNormal[]): PriceModel {
  return { n, parts, median: quantile(0.5, parts), low: quantile(0.25, parts), high: quantile(0.75, parts) };
}

const FALLBACK = makeModel(0, [{ mu: Math.log(15), sigma: 1 }]);

function fit(prices: number[]): PriceModel {
  const logs = prices.map(Math.log);
  const mu = logs.reduce((a, b) => a + b, 0) / logs.length;
  const sd = logs.length > 1 ? Math.sqrt(logs.reduce((s, x) => s + (x - mu) ** 2, 0) / (logs.length - 1)) : 0.6;
  const sigma = Math.max(sd, logs.length >= 3 ? MIN_SIGMA : MIN_SIGMA_FEW_SAMPLES);
  return makeModel(prices.length, [{ mu, sigma }]);
}

/** Price vs player quality: ln(price) = a + b * ln(search_rank). Lower search_rank = better player. */
export interface QualityModel {
  a: number;
  b: number;
  sigma: number;
  n: number;
  r2: number;
  /** highest price ever observed; predictions are capped here so top-ranked players don't extrapolate past reality */
  maxPrice: number;
}

const MIN_QUALITY_SAMPLES = 8;
const MIN_QUALITY_SIGMA = 0.6;

export function buildQualityModel(points: { searchRank: number; price: number }[]): QualityModel | null {
  const pts = points.filter((p) => p.searchRank > 0 && p.price > 0);
  if (pts.length < MIN_QUALITY_SAMPLES) return null;
  const x = pts.map((p) => Math.log(p.searchRank));
  const y = pts.map((p) => Math.log(p.price));
  const mx = x.reduce((a, b) => a + b, 0) / x.length;
  const my = y.reduce((a, b) => a + b, 0) / y.length;
  const sxx = x.reduce((s, xi) => s + (xi - mx) ** 2, 0);
  if (sxx === 0) return null;
  const b = x.reduce((s, xi, i) => s + (xi - mx) * (y[i] - my), 0) / sxx;
  const a = my - b * mx;
  const sse = y.reduce((s, yi, i) => s + (yi - (a + b * x[i])) ** 2, 0);
  const sst = y.reduce((s, yi) => s + (yi - my) ** 2, 0);
  return { a, b, n: pts.length, maxPrice: Math.max(...pts.map((p) => p.price)), r2: sst > 0 ? 1 - sse / sst : 0, sigma: Math.max(Math.sqrt(sse / (pts.length - 2)), MIN_QUALITY_SIGMA) };
}

/**
 * Learn what chopped-team players cost, by how much the market wanted them. Within each past chop the
 * winning bids are sorted high to low; rank 0 is the priciest. A newcomer would have had to beat that
 * winning bid, so the winning bids are samples of the price to beat.
 */
export function buildPriceModels(results: AuctionResult[]): Map<number, PriceModel> {
  const byWeek = new Map<number, number[]>();
  for (const r of results) {
    if (!r.chop_pool || r.winning_bid <= 0) continue;
    byWeek.set(r.week, [...(byWeek.get(r.week) ?? []), r.winning_bid]);
  }
  const groups = new Map<number, number[]>();
  for (const prices of byWeek.values()) {
    prices.sort((a, b) => b - a).forEach((price, rank) => {
      const g = rankGroup(rank);
      groups.set(g, [...(groups.get(g) ?? []), price]);
    });
  }
  return new Map([...groups].map(([g, p]) => [g, fit(p)]));
}

export const winProbability = (bid: number, m: PriceModel) => cdf(bid, m.parts);

/**
 * The bid that maximizes expected surplus, p(win) * (value - bid). You pay your own bid when you win, so
 * the best bid sits below your value. Returns null when nothing is worth bidding.
 */
export function optimalBid(value: number, maxBid: number, m: PriceModel) {
  const ceiling = Math.floor(Math.min(value, maxBid));
  let best: { bid: number; p: number; surplus: number } | null = null;
  for (let b = 1; b <= ceiling; b++) {
    const p = winProbability(b, m);
    const surplus = p * (value - b);
    if (!best || surplus > best.surplus) best = { bid: b, p, surplus };
  }
  if (!best || best.surplus < 0.5) return null;
  // Rivals cluster on round numbers, so sit one dollar above them.
  if (best.bid % 5 === 0 && best.bid + 1 <= ceiling) {
    const bid = best.bid + 1;
    const p = winProbability(bid, m);
    best = { bid, p, surplus: p * (value - bid) };
  }
  return best;
}

export interface PlanCandidate {
  id: string;
  name: string;
  pos: string;
  /** projected points this week */
  pts: number;
  /** 0 = most wanted in the pool */
  demandRank: number;
  /** Sleeper's overall player ranking (1 = best); null if unknown */
  searchRank?: number | null;
}

export interface PlanItem {
  id: string;
  name: string;
  pos: string;
  demand_rank: number;
  gain_alone: number;
  /** expected gain given which earlier targets you might also win */
  gain_expected: number;
  value: number;
  /** "bid" = a realistic chance to win; "long shot" = bid anyway only because losing costs nothing; "skip" = not worth a claim */
  verdict: "bid" | "long shot" | "skip";
  bid: number | null;
  win_probability: number | null;
  expected_surplus: number | null;
  price_to_beat: { median: number; low: number; high: number; samples: number };
  /** what the median price to beat works out to per point of weekly gain; compare with your own dollars_per_point */
  implied_dollars_per_point: number | null;
}

const REALISTIC_WIN_PROBABILITY = 0.25;
const MIN_GAIN = 0.5; // points per week below which a player isn't worth a claim
const OVERLAP_LOOKBACK = 4; // earlier targets considered when discounting overlapping slots

/**
 * Size a bid for each player in a pool. `lineupWith(extra)` must return your best lineup total with `extra`
 * players added to your roster. Gains are not additive (two players for the same slot), so each target's
 * gain is averaged over the chance of having won the better targets before it.
 */
export function planBids(input: {
  candidates: PlanCandidate[];
  lineupWith: (extra: Candidate[]) => number;
  models: Map<number, PriceModel>;
  /** optional price-vs-quality view, blended in for non-QBs */
  quality?: QualityModel | null;
  dollarsPerPoint: number;
  maxBid: number;
}): PlanItem[] {
  // QBs are cheap in one-QB leagues, so only pool rank is used for them.
  const modelFor = (c: PlanCandidate): PriceModel => {
    const byRank = input.models.get(rankGroup(c.demandRank)) ?? FALLBACK;
    if (!input.quality || !c.searchRank || c.pos === "QB") return byRank;
    const q = input.quality;
    return makeModel(Math.min(byRank.n, q.n), [...byRank.parts, { mu: Math.min(q.a + q.b * Math.log(c.searchRank), Math.log(q.maxPrice)), sigma: q.sigma }]);
  };
  const asCand = (c: PlanCandidate): Candidate => ({ id: c.id, pos: c.pos, pts: c.pts });
  const base = input.lineupWith([]);
  const ranked = input.candidates
    .map((c) => ({ c, alone: input.lineupWith([asCand(c)]) - base }))
    .sort((a, b) => b.alone - a.alone);

  const chosen: { c: PlanCandidate; p: number }[] = [];
  const items: PlanItem[] = [];

  for (const { c, alone } of ranked) {
    const model = modelFor(c);
    const price_to_beat = { median: model.median, low: model.low, high: model.high, samples: model.n };
    const item: PlanItem = {
      id: c.id,
      name: c.name,
      pos: c.pos,
      demand_rank: c.demandRank + 1,
      gain_alone: round(alone),
      gain_expected: 0,
      value: 0,
      verdict: "skip",
      bid: null,
      win_probability: null,
      expected_surplus: null,
      price_to_beat,
      implied_dollars_per_point: null,
    };
    if (alone < MIN_GAIN) {
      items.push(item);
      continue;
    }

    const prior = chosen.slice(0, OVERLAP_LOOKBACK);
    let expected = 0;
    for (let mask = 0; mask < 1 << prior.length; mask++) {
      let weight = 1;
      const extra: Candidate[] = [];
      prior.forEach((q, i) => {
        if ((mask >> i) & 1) {
          weight *= q.p;
          extra.push(asCand(q.c));
        } else weight *= 1 - q.p;
      });
      if (weight < 1e-6) continue;
      expected += weight * (input.lineupWith([...extra, asCand(c)]) - input.lineupWith(extra));
    }

    item.gain_expected = round(expected);
    item.implied_dollars_per_point = expected > 0.05 ? Math.round(model.median / expected) : null;
    item.value = Math.round(expected * input.dollarsPerPoint);
    const best = optimalBid(item.value, input.maxBid, model);
    if (best) {
      item.bid = best.bid;
      item.verdict = best.p >= REALISTIC_WIN_PROBABILITY ? "bid" : "long shot";
      item.win_probability = round(best.p);
      item.expected_surplus = round(best.surplus);
      chosen.push({ c, p: best.p });
    }
    items.push(item);
  }

  const order = { bid: 0, "long shot": 1, skip: 2 } as const;
  return items.sort((a, b) => order[a.verdict] - order[b.verdict] || (b.expected_surplus ?? -1) - (a.expected_surplus ?? -1) || b.gain_alone - a.gain_alone);
}
