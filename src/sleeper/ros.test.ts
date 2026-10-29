import test from "node:test";
import assert from "node:assert/strict";
import { replacementLevels, pointsAboveReplacement, rosterOutlook, type Ros } from "./ros.js";

const entry = (weekly: Record<number, number>) => {
  const w = new Map(Object.entries(weekly).map(([k, v]) => [Number(k), v]));
  const total = [...w.values()].reduce((a, b) => a + b, 0);
  return { weekly: w, games: w.size, total, avg: w.size ? total / w.size : 0 };
};

test("replacement level sits just outside the starter pool, flex included", () => {
  // 2 teams, slots: 1 RB + 1 FLEX(RB/WR/TE). RBs: 20,15,10,5; WRs: 12,9,6,3.
  const ros: Ros = new Map();
  const pos: Record<string, string> = {};
  [20, 15, 10, 5].forEach((v, i) => { ros.set(`rb${i}`, entry({ 1: v })); pos[`rb${i}`] = "RB"; });
  [12, 9, 6, 3].forEach((v, i) => { ros.set(`wr${i}`, entry({ 1: v })); pos[`wr${i}`] = "WR"; });
  const lv = replacementLevels(ros, (id) => pos[id], ["RB", "FLEX"], 2);
  // strict: top 2 RBs (20,15). Flex pool (2 slots): best leftovers across RB(10,5)+WR(12,9,...) = 12, 10 -> 1 WR + 1 RB
  // So RB starters = 3 (20,15,10), WR starters = 1 (12). Replacement = mean of next 3 players beyond that.
  assert.equal(lv.RB, 5); // only one RB left (5)
  assert.equal(lv.WR, (9 + 6 + 3) / 3);
});

test("points above replacement ignore weeks below replacement", () => {
  const e = entry({ 1: 12, 2: 4, 3: 10 });
  assert.equal(pointsAboveReplacement(e, 8), 4 + 0 + 2);
});

test("roster outlook shows bye weeks and what they cost", () => {
  const ros: Ros = new Map([
    ["qb", entry({ 1: 20, 2: 20, 3: 20 })],
    ["rb", entry({ 1: 10, 3: 10 })], // bye in week 2
    ["wr", entry({ 1: 8, 2: 8, 3: 8 })],
  ]);
  const roster = [
    { id: "qb", name: "QB One", pos: "QB" },
    { id: "rb", name: "RB One", pos: "RB" },
    { id: "wr", name: "WR One", pos: "WR" },
  ];
  const o = rosterOutlook(roster, ros, [1, 2, 3], ["QB", "RB", "WR"]);
  assert.equal(o[0].lineup_projection, 38);
  assert.equal(o[1].lineup_projection, 28);
  assert.deepEqual(o[1].on_bye, ["RB One"]);
  assert.deepEqual(o[1].empty_slots, ["RB"]);
  assert.equal(o[1].bye_cost, 10);
  assert.equal(o[0].bye_cost, 0);
});
