import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTrade, findTrades, seasonValue, type TradeSetup, type TradeTeam, type TeamPlayer } from "./trades.js";

const setup: TradeSetup = {
  slots: ["RB", "WR"],
  weeks: [1, 2, 3, 4],
  weight: (w) => (w >= 3 ? 2 : 1), // pretend weeks 3-4 are the playoffs and count double
  replacement: { RB: 4, WR: 4 },
  maxRoster: 4,
};
const player = (id: string, pos: string, pts: number, byeWeek?: number): TeamPlayer => {
  const weekly = new Map<number, number>();
  for (const w of setup.weeks) if (w !== byeWeek) weekly.set(w, pts);
  const total = [...weekly.values()].reduce((a, b) => a + b, 0);
  return { id, name: id, pos, weekly, total, par: Math.max(0, total - 4 * weekly.size) };
};

// A is deep at RB and has no real WR; B is the opposite.
const A: TradeTeam = { key: "a", name: "A", players: [player("rbA1", "RB", 15), player("rbA2", "RB", 14), player("wrA", "WR", 5)] };
const B: TradeTeam = { key: "b", name: "B", players: [player("wrB1", "WR", 15), player("wrB2", "WR", 14), player("rbB", "RB", 5)] };

test("replacement-level free agents fill empty slots", () => {
  const v = seasonValue([], setup);
  assert.equal(v.byWeek.get(1), 8); // RB 4 + WR 4
});

test("a trade that fills each team's need helps both; the playoff weeks are reported separately", () => {
  // A swaps its spare RB for B's spare WR
  const r = evaluateTrade(A, B, ["rbA2"], ["wrB2"], setup, 3);
  assert.ok(r.you.change > 0, "A should gain");
  assert.ok(r.them.change > 0, "B should gain");
  assert.ok(r.you.playoff_change > 0);
  // A: before RB 15 + WR 5 per week; after RB 15 + WR 14. weeks 1-2 gain 9 each; weeks 3-4 gain 9 each at weight 2
  assert.equal(r.you.change, 9 * 2 + 9 * 2 * 2);
});

test("a lopsided trade shows the other side losing", () => {
  const r = evaluateTrade(A, B, ["wrA"], ["wrB1"], setup, 3); // A gives a bad WR for B's best WR
  assert.ok(r.you.change > 0);
  assert.ok(r.them.change < 0);
});

test("a 2-for-1 over the roster limit drops the least valuable player", () => {
  const full: TradeTeam = { key: "c", name: "C", players: [player("x1", "RB", 15), player("x2", "RB", 14), player("x3", "WR", 9), player("x4", "WR", 3)] };
  const r = evaluateTrade(full, B, [], ["wrB1"], setup, 3); // receives a 5th player
  assert.deepEqual(r.you.drops, ["x4"]);
});

test("findTrades returns only trades that help both sides", () => {
  const found = findTrades(A, [B], setup, 3, { minYourGain: 1, minTheirGain: 1, limit: 5, allowTwoForOne: false });
  assert.ok(found.length > 0);
  for (const t of found) {
    assert.ok(t.you.change >= 1 && t.them.change >= 1);
  }
});

test("findTrades collapses throw-ins that don't matter into one trade per target", () => {
  // A has two replacement-level extras that cost nothing to give; both fetch the same WR from B.
  const A2: TradeTeam = { key: "a2", name: "A2", players: [player("rb1", "RB", 15), player("rb2", "RB", 14), player("wrA", "WR", 5), player("bench1", "RB", 2), player("bench2", "RB", 3)] };
  const found = findTrades(A2, [B], setup, 3, { minYourGain: 1, minTheirGain: -100, limit: 20, allowTwoForOne: false });
  const targets = found.map((t) => [...t.you_get].sort().join(","));
  assert.equal(new Set(targets).size, targets.length, "each set of targets appears once");
});

test("maxValueGap keeps only trades that look even on raw value; perTeam caps one partner", () => {
  const loose = findTrades(A, [B], setup, 3, { minYourGain: 1, minTheirGain: -1000, limit: 50, allowTwoForOne: true });
  const tight = findTrades(A, [B], setup, 3, { minYourGain: 1, minTheirGain: -1000, limit: 50, allowTwoForOne: true, maxValueGap: 0 });
  assert.ok(tight.length < loose.length, "the value limit removes trades");
  for (const t of tight) assert.ok(t.value.you_get - t.value.you_give <= 0);
  const capped = findTrades(A, [B], setup, 3, { minYourGain: 1, minTheirGain: -1000, limit: 50, allowTwoForOne: true, perTeam: 1 });
  assert.equal(capped.length, 1);
});
