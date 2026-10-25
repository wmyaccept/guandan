// Paired deals: swap hard/medium teams on each identical seed to reduce seat bias.
// Usage: node scripts/ai-benchmark.mjs [deal-count=40] [seed=20000]
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { autoAct, createMatch, startRound } from "../server/game/engine.js";
function rng(seed) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const deals = Number(process.argv[2] ?? 40);
const seed = Number(process.argv[3] ?? 20000);
assert.ok(Number.isInteger(deals) && deals > 0);
const stats = { games: deals * 2, hardHeads: 0, mediumHeads: 0, hardDouble: 0, mediumDouble: 0,
  hardUpgradePoints: 0, mediumUpgradePoints: 0 };
const times = [];
for (let deal = 0; deal < deals; deal += 1) {
  for (const hardTeam of [0, 1]) {
    const match = createMatch(["A", "B", "C", "D"], { bots: [true, true, true, true] });
    startRound(match, rng(seed + deal));
    const random = rng(seed + deal + 100000);
    let steps = 0;
    while (match.phase === "play" && steps++ < 2000) {
      match.difficulty = match.turn % 2 === hardTeam ? "hard" : "medium";
      const before = performance.now();
      const result = autoAct(match, match.turn, random);
      if (match.difficulty === "hard") times.push(performance.now() - before);
      assert.equal(result.ok, true, result.error);
    }
    assert.equal(match.phase, "roundOver");
    const [first, second, third] = match.finishOrder;
    const winner = first % 2 === hardTeam ? "hard" : "medium";
    stats[winner + "Heads"] += 1;
    const double = first % 2 === second % 2;
    stats[winner + "Double"] += Number(double);
    stats[winner + "UpgradePoints"] += double ? 3 : first % 2 === third % 2 ? 2 : 1;
  }
}
times.sort((a, b) => a - b);
console.log(JSON.stringify({ seed, ...stats, hardActionMs: {
  mean: times.reduce((a, b) => a + b, 0) / times.length,
  p95: times[Math.floor(times.length * 0.95)], max: times.at(-1)
} }, null, 2));
