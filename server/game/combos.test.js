import assert from "node:assert/strict";
import test from "node:test";
import { makeCard } from "./cards.js";
import { TYPES, canBeat, parseCombo, parseCombos } from "./combos.js";

function cards(...specs) {
  return specs.map((spec, index) => {
    const suit = spec.slice(0, 1);
    const rankText = spec.slice(1);
    const rankMap = { J: 11, Q: 12, K: 13, A: 14, 小: 16, 大: 17 };
    const rank = rankMap[rankText] ?? Number(rankText);
    return makeCard(index, suit, rank);
  });
}

test("single pair triple and bomb", () => {
  const level = 15;
  assert.equal(parseCombo(cards("S5"), level).type, TYPES.SINGLE);
  assert.equal(parseCombo(cards("S7", "H7"), level).type, TYPES.PAIR);
  assert.equal(parseCombo(cards("S9", "H9", "D9"), level).type, TYPES.TRIPLE);
  const bomb = parseCombo(cards("S4", "H4", "D4", "C4"), level);
  assert.equal(bomb.type, TYPES.BOMB);
  assert.equal(bomb.length, 4);
});

test("wild heart level can complete a pair", () => {
  const combo = parseCombo(cards("S8", "H15"), 15);
  assert.equal(combo.type, TYPES.PAIR);
  assert.equal(combo.rank, 8);
});

test("straight and flush straight", () => {
  const straight = parseCombo(cards("S3", "H4", "D5", "C6", "S7"), 15);
  assert.equal(straight.type, TYPES.STRAIGHT);
  const flush = parseCombo(cards("H3", "H4", "H5", "H6", "H7"), 15);
  assert.equal(flush.type, TYPES.FLUSH_STRAIGHT);
  assert.equal(canBeat(flush, straight), true);
});

test("full house pair sequence and steel plate", () => {
  const house = parseCombo(cards("S5", "H5", "D5", "S9", "H9"), 15);
  assert.equal(house.type, TYPES.FULL_HOUSE);
  const pairs = parseCombo(cards("S3", "H3", "S4", "H4", "S5", "H5"), 15);
  assert.equal(pairs.type, TYPES.PAIR_SEQ);
  const plate = parseCombo(cards("S6", "H6", "D6", "S7", "H7", "D7"), 15);
  assert.equal(plate.type, TYPES.TRIPLE_SEQ);
});

test("joker bomb beats six bomb", () => {
  const six = parseCombo(cards("S8", "H8", "D8", "C8", "S8", "H15"), 15);
  const jokers = parseCombo(cards("J16", "J16", "J17", "J17"), 15);
  assert.equal(jokers.type, TYPES.JOKER_BOMB);
  assert.equal(canBeat(jokers, six), true);
  assert.equal(canBeat(six, jokers), false);
});

test("two cannot sit in a straight", () => {
  assert.equal(parseCombo(cards("SA", "H15", "S3", "S4", "S5"), 7), null);
});

test("same type must be longer equal and higher", () => {
  const low = parseCombo(cards("S4"), 15);
  const high = parseCombo(cards("SA"), 15);
  assert.equal(canBeat(high, low), true);
  const pair = parseCombo(cards("S4", "H4"), 15);
  assert.equal(canBeat(pair, low), false);
});

test("parseCombos can read wilds as themselves", () => {
  const found = parseCombos(cards("H5", "S5"), 5);
  assert.ok(found.some((item) => item.type === TYPES.PAIR && item.rank === 5));
});
