import assert from "node:assert/strict";
import test from "node:test";
import { LEVELS, makeCard, rankValue, sortHand } from "./cards.js";
import { TYPES, canBeat, parseCombo, parseCombos } from "./combos.js";
import { generatePlays } from "./moves.js";

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

test("runs follow the natural ladder, so A2345 is the weakest straight", () => {
  const aceLow = parseCombo(cards("SA", "H15", "S3", "D4", "C5"), 7);
  assert.equal(aceLow.type, TYPES.STRAIGHT);
  assert.equal(aceLow.rank, 5);
  const plain = parseCombo(cards("S3", "H4", "D5", "C6", "S7"), 7);
  assert.equal(canBeat(plain, aceLow), true);
  const aceHigh = parseCombo(cards("S10", "HJ", "DQ", "CK", "SA"), 7);
  assert.equal(aceHigh.type, TYPES.STRAIGHT);
  assert.equal(aceHigh.rank, 14);
  assert.equal(canBeat(aceHigh, plain), true);
  // 2 only sits right after A; JQKA2 is not a run and jokers never join one
  assert.equal(parseCombo(cards("SJ", "HQ", "DK", "CA", "S15"), 7), null);
  assert.equal(parseCombo(cards("J16", "J16", "S3", "S4", "S5"), 7), null);
});

test("level card keeps its natural slot inside runs", () => {
  const plate = parseCombo(cards("S15", "H15", "S3", "H3", "S4", "H4"), 14);
  assert.equal(plate.type, TYPES.PAIR_SEQ);
  assert.equal(plate.rank, 4);
  const higher = parseCombo(cards("S5", "H5", "S6", "H6", "S7", "H7"), 14);
  assert.equal(canBeat(higher, plate), true);
  const lowSteel = parseCombo(cards("S14", "H14", "D14", "S15", "H15", "D15"), 7);
  assert.equal(lowSteel.type, TYPES.TRIPLE_SEQ);
  assert.equal(lowSteel.rank, 2);
  const steel = parseCombo(cards("S13", "H13", "D13", "S14", "H14", "D14"), 7);
  assert.equal(steel.type, TYPES.TRIPLE_SEQ);
  assert.equal(steel.rank, 14);
  assert.equal(canBeat(steel, lowSteel), true);
  const hand = [
    makeCard(0, "S", 15), makeCard(1, "S", 15),
    makeCard(0, "S", 3), makeCard(1, "S", 3),
    makeCard(0, "S", 4), makeCard(1, "S", 4)
  ];
  assert.ok(
    generatePlays(hand, 14).some((item) => item.type === TYPES.PAIR_SEQ),
    "playing A should still generate the 223344 pair run"
  );
});

test("full house can carry a joker pair", () => {
  const small = parseCombo(cards("S3", "H3", "D3", "J16", "J16"), 15);
  assert.equal(small.type, TYPES.FULL_HOUSE);
  assert.equal(small.rank, 3);
  const big = parseCombo(cards("S9", "H9", "D9", "J17", "J17"), 15);
  assert.equal(big.type, TYPES.FULL_HOUSE);
  assert.equal(canBeat(big, small), true);
  assert.equal(canBeat(small, big), false);
  const wildOnTriple = parseCombo(cards("S9", "H9", "J17", "J17", "H15"), 15);
  assert.equal(wildOnTriple.type, TYPES.FULL_HOUSE);
  assert.equal(wildOnTriple.rank, 9);
  const wildAsJoker = parseCombo(cards("S9", "H9", "D9", "J17", "H15"), 15);
  assert.equal(wildAsJoker?.type === TYPES.FULL_HOUSE, false);
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


test("pair sequence and steel plate are exactly six cards", () => {
  const longPairs = parseCombo(cards("S3", "H3", "S4", "H4", "S5", "H5", "S6", "H6"), 15);
  assert.equal(longPairs, null);
  const longPlate = parseCombo(cards("S3", "H3", "D3", "S4", "H4", "D4", "S5", "H5", "D5"), 15);
  assert.equal(longPlate, null);
  const pairs = parseCombo(cards("S3", "H3", "S4", "H4", "S5", "H5"), 15);
  assert.equal(pairs.type, TYPES.PAIR_SEQ);
  const plate = parseCombo(cards("S6", "H6", "D6", "S7", "H7", "D7"), 15);
  assert.equal(plate.type, TYPES.TRIPLE_SEQ);
});

test("generatePlays never repeats a wild inside one combo", () => {
  const hand = [makeCard(0, "C", 6), makeCard(1, "C", 6), makeCard(0, "H", 6), makeCard(0, "S", 9)];
  for (const combo of generatePlays(hand, 6)) {
    const ids = combo.cards.map((card) => card.id);
    assert.equal(new Set(ids).size, ids.length, combo.label);
  }
});

test("level card outranks A and plain 2 is weakest", () => {
  const level = 4;
  const four = parseCombo(cards("S4"), level);
  const queen = parseCombo(cards("SQ"), level);
  const ace = parseCombo(cards("SA"), level);
  const two = parseCombo(cards("S15"), level);
  const three = parseCombo(cards("S3"), level);
  assert.equal(canBeat(four, queen), true);
  assert.equal(canBeat(queen, four), false);
  assert.equal(canBeat(four, ace), true);
  assert.equal(canBeat(two, three), false);
  assert.equal(canBeat(three, two), true);
  const fourBomb = parseCombo(cards("S4", "D4", "C4", "H4"), level);
  const aceBomb = parseCombo(cards("SA", "HA", "DA", "CA"), level);
  assert.equal(fourBomb.type, TYPES.BOMB);
  assert.equal(canBeat(fourBomb, aceBomb), true);
  assert.equal(canBeat(aceBomb, fourBomb), false);
});

test("hand sort keeps 2 lowest and level card above A", () => {
  const hand = [
    makeCard(0, "S", 15),
    makeCard(1, "S", 14),
    makeCard(2, "S", 4),
    makeCard(3, "S", 3),
    makeCard(4, "J", 16)
  ];
  const sorted = sortHand(hand, 4).map((card) => card.rank);
  assert.deepEqual(sorted, [15, 3, 14, 4, 16]);
});

test("rank order holds for every level", () => {
  const label = { 13: "K", 14: "A" };
  for (const level of LEVELS) {
    assert.equal(rankValue(level, level), 16);
    for (let rank = 3; rank <= 15; rank += 1) {
      if (rank === level) continue;
      assert.equal(rankValue(rank, level), rank === 15 ? 2 : rank);
    }
    const victim = level === 14 ? 13 : 14;
    const top = parseCombo(cards("S" + level), level);
    const prey = parseCombo(cards("S" + label[victim]), level);
    assert.equal(canBeat(top, prey), true);
    assert.equal(canBeat(prey, top), false);
    if (level !== 15) {
      const three = parseCombo(cards("S3"), level);
      const two = parseCombo(cards("S15"), level);
      assert.equal(canBeat(three, two), true);
      assert.equal(canBeat(two, three), false);
    }
  }
});
test("hand sort after a level change keeps Q K A on the right", () => {
  const hand = [
    makeCard(0, "S", 14),
    makeCard(1, "S", 12),
    makeCard(2, "S", 13),
    makeCard(3, "S", 11),
    makeCard(4, "S", 10),
    makeCard(5, "S", 5),
    makeCard(6, "S", 15),
    makeCard(7, "J", 16),
    makeCard(8, "J", 17)
  ];
  assert.deepEqual(sortHand(hand, 5).map((card) => card.rank), [15, 10, 11, 12, 13, 14, 5, 16, 17]);
});

test("wild heart turns 77AA into two possible full houses", () => {
  const houses = parseCombos(cards("S7", "H7", "SA", "HA", "H5"), 5)
    .filter((item) => item.type === TYPES.FULL_HOUSE)
    .map((item) => [item.rank, item.pairRank])
    .sort((a, b) => a[0] - b[0]);
  assert.deepEqual(houses, [[7, 14], [14, 7]]);
});

test("ace reading of 77AA beats 88899 while the seven reading does not", () => {
  const target = parseCombo(cards("S8", "H8", "D8", "S9", "H9"), 5);
  const found = parseCombos(cards("S7", "H7", "SA", "HA", "H5"), 5);
  const aces = found.find((item) => item.type === TYPES.FULL_HOUSE && item.rank === 14);
  const sevens = found.find((item) => item.type === TYPES.FULL_HOUSE && item.rank === 7);
  assert.ok(aces && sevens);
  assert.equal(canBeat(aces, target), true);
  assert.equal(canBeat(sevens, target), false);
});

test("a lone wild heart card only reads as its own single", () => {
  const found = parseCombos(cards("H5"), 5);
  assert.equal(found.length, 1);
  assert.equal(found[0].type, TYPES.SINGLE);
  assert.equal(found[0].rank, 5);
});

test("same suit run keeps both straight and flush straight readings", () => {
  const found = parseCombos(cards("S5", "S6", "S7", "S8", "S9"), 5);
  assert.ok(found.some((item) => item.type === TYPES.STRAIGHT));
  assert.ok(found.some((item) => item.type === TYPES.FLUSH_STRAIGHT));
});

test("wild card at a run end keeps both start positions", () => {
  const starts = [...new Set(parseCombos(cards("S5", "S6", "S7", "S8", "H5"), 5)
    .filter((item) => item.type === TYPES.STRAIGHT)
    .map((item) => item.start))].sort((a, b) => a - b);
  assert.deepEqual(starts, [4, 5]);
});
