import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { makeCard, rankAtPosition } from "./game/cards.js";
import { parseCombos, TYPES } from "./game/combos.js";

// Exercise the browser's actual display helpers without booting sockets or a DOM.
const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const start = source.indexOf("function comboValue(");
const end = source.indexOf("function renderTrick(", start);
assert.ok(start >= 0 && end > start);
const display = vm.runInNewContext(`${source.slice(start, end)}\n({ wildRepresentations, sortComboCards })`);

function cards(...specs) {
  return specs.map((spec, index) => makeCard(index, spec[0], Number(spec.slice(1))));
}

function checkDisplay(combo, level) {
  const before = JSON.stringify(combo);
  const reps = display.wildRepresentations(combo, combo.cards, level);
  const sorted = display.sortComboCards(combo, level, reps);
  const ranks = Array.from(sorted, (card) => reps.get(card.id) ?? card.rank);
  const expected = [];
  if (combo.run) {
    for (let offset = 0; offset < combo.run; offset += 1) {
      for (let copy = 0; copy < combo.copies; copy += 1) {
        expected.push(rankAtPosition(combo.start + offset));
      }
    }
  } else if (combo.type === TYPES.FULL_HOUSE) {
    expected.push(combo.rank, combo.rank, combo.rank, combo.pairRank, combo.pairRank);
  } else {
    expected.push(...Array(combo.cards.length).fill(combo.rank));
  }
  assert.deepEqual(ranks, expected, `level=${level}, type=${combo.type}, start=${combo.start}`);
  assert.equal(reps.size, combo.cards.filter((card) => card.suit === "H" && card.rank === level).length);
  assert.equal(new Set(sorted.map((card) => card.id)).size, combo.cards.length);
  assert.equal(JSON.stringify(combo), before, "display must not mutate the engine combo");
  return reps;
}

test("wild display fills the missing run rank instead of an occupied slot", () => {
  const hand = cards("S5", "D6", "C7", "S8", "H5");
  const runs = parseCombos(hand, 5).filter((combo) => combo.type === TYPES.STRAIGHT);
  assert.deepEqual(runs.map((combo) => combo.start).sort((a, b) => a - b), [4, 5]);
  for (const combo of runs) {
    const reps = checkDisplay(combo, 5);
    assert.equal(reps.get(hand[4].id), combo.start === 4 ? 4 : 9);
  }
});

test("two wilds keep their labels and positions when one represents its own rank", () => {
  const hand = cards("S3", "D4", "C6", "H5", "H5");
  const combo = parseCombos(hand, 5).find((item) => item.type === TYPES.STRAIGHT && item.start === 3);
  const reps = checkDisplay(combo, 5);
  assert.equal(reps.get(hand[3].id), 5);
  assert.equal(reps.get(hand[4].id), 7);
});

test("wild labels and card ordering agree with every engine run interpretation", () => {
  const shapes = [
    [TYPES.STRAIGHT, 5, 1],
    [TYPES.FLUSH_STRAIGHT, 5, 1],
    [TYPES.PAIR_SEQ, 3, 2],
    [TYPES.TRIPLE_SEQ, 2, 3]
  ];
  for (let level = 3; level <= 15; level += 1) {
    for (const [type, run, copies] of shapes) {
      for (let start = 1; start + run - 1 <= 14; start += 1) {
        const base = [];
        for (let offset = 0; offset < run; offset += 1) {
          for (let copy = 0; copy < copies; copy += 1) {
            base.push(makeCard(base.length, "S", rankAtPosition(start + offset)));
          }
        }
        for (let first = 0; first < base.length; first += 1) {
          for (let second = first; second < base.length; second += 1) {
            const hand = base.map((card, index) => index === first || index === second
              ? makeCard(index, "H", level) : card);
            const combos = parseCombos(hand, level).filter((combo) => combo.type === type);
            assert.ok(combos.some((combo) => combo.start === start));
            for (const combo of combos) checkDisplay(combo, level);
          }
        }
      }
    }
  }
});

test("full houses and same-rank combos retain correct wild labels", () => {
  const hands = [
    cards("H5"), cards("H5", "H5"), cards("S7", "H5"),
    cards("S7", "D7", "H5"), cards("S7", "D7", "C7", "H5"),
    cards("S7", "D7", "S14", "D14", "H5"),
    cards("S7", "D7", "S5", "H5", "H5"),
    cards("S7", "D7", "J17", "J17", "H5")
  ];
  for (const hand of hands) {
    const combos = parseCombos(hand, 5);
    assert.ok(combos.length);
    for (const combo of combos) checkDisplay(combo, 5);
  }
});
