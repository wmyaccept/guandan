import assert from "node:assert/strict";
import test from "node:test";
import { makeCard } from "./cards.js";
import { parseCombo } from "./combos.js";
import { chooseAction, decompose, isTopOfKind, suggestPlays, unseenCounts } from "./ai.js";
import { autoAct, createMatch, startRound } from "./engine.js";

const RANK_MAP = { J: 11, Q: 12, K: 13, A: 14 };
const SUITS = ["S", "H", "D", "C"];

function makeHand(...specs) {
  const seen = new Map();
  return specs.map((spec) => {
    const suit = spec.slice(0, 1);
    const text = spec.slice(1);
    const rank = RANK_MAP[text] ?? Number(text);
    const key = suit + rank;
    const deck = seen.get(key) ?? 0;
    seen.set(key, deck + 1);
    return makeCard(deck, suit, rank);
  });
}

function filler(count, start = 0) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const n = start + i;
    out.push(makeCard(Math.floor(n / 52) % 2, SUITS[n % 4], 3 + (Math.floor(n / 4) % 13)));
  }
  return out;
}

function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function table({ hands, current = null, turn = 0, passes = 0, winner = null, level = 15, finishOrder = [] }) {
  const lastPlay = current ? { seat: winner ?? (turn + 3) % 4, combo: current } : null;
  return {
    names: ["甲", "乙", "丙", "丁"],
    bots: [true, true, true, true],
    phase: "play",
    round: 1,
    teamLevel: [level, level],
    bankerTeam: 0,
    hands,
    playedCards: [],
    current,
    lastPlay,
    leadSeat: lastPlay ? lastPlay.seat : turn,
    turn,
    passes,
    finishOrder,
    log: []
  };
}

test("队友的牌不压", () => {
  const current = parseCombo(makeHand("S9"), 15);
  const match = table({
    hands: [
      makeHand("SA", "S3", "D4", "C5", "S6", "H7"),
      filler(12, 4),
      filler(12, 20),
      filler(12, 32)
    ],
    current,
    turn: 0,
    winner: 2
  });
  assert.equal(chooseAction(match, 0, 15).action, "pass");
});

test("压上家先出小牌，不浪费大王", () => {
  const current = parseCombo(makeHand("S5"), 15);
  const match = table({
    hands: [makeHand("S3", "S6", "SA", "J17", "D8", "C9"), filler(12, 4), filler(12, 20), filler(12, 32)],
    current,
    turn: 0,
    winner: 1
  });
  const decision = chooseAction(match, 0, 15);
  assert.equal(decision.action, "play");
  assert.deepEqual(decision.cardIds, ["0-S-6"]);
});

test("不会为了压小牌拆掉炸弹", () => {
  const current = parseCombo(makeHand("S5"), 15);
  const hand = makeHand("S9", "H9", "D9", "C9", "S3", "S4", "D3", "C4", "H3", "D4");
  const match = table({
    hands: [hand, filler(20, 4), filler(20, 26), filler(12, 32)],
    current,
    turn: 0,
    winner: 1
  });
  assert.equal(chooseAction(match, 0, 15).action, "pass");
  match.passes = 2;
  assert.equal(chooseAction(match, 0, 15).action, "pass");
});

test("对手快走完时用炸弹拦", () => {
  const current = parseCombo(makeHand("S5"), 15);
  const hand = makeHand("S4", "H4", "D4", "C4", "S3", "H3", "D3", "C3", "S3", "H3");
  const quiet = table({
    hands: [hand, filler(20, 4), filler(20, 26), filler(12, 32)],
    current,
    turn: 0,
    winner: 1
  });
  assert.equal(chooseAction(quiet, 0, 15).action, "pass");

  const urgent = table({
    hands: [hand, filler(5, 4), filler(20, 26), filler(12, 32)],
    current,
    turn: 0,
    winner: 1
  });
  const decision = chooseAction(urgent, 0, 15);
  assert.equal(decision.action, "play");
  assert.equal(decision.cardIds.length, 4);
  assert.ok(decision.cardIds.every((id) => id.endsWith("-4")));
});

test("领出时优先甩长牌型而不是一直出单张", () => {
  const hand = makeHand("S3", "H4", "D5", "C6", "S7", "H9", "D11", "C13");
  const match = table({ hands: [hand, filler(12, 4), filler(12, 20), filler(12, 32)], turn: 0 });
  const decision = chooseAction(match, 0, 15);
  assert.equal(decision.action, "play");
  assert.equal(decision.cardIds.length, 5);
});

test("能一把走完就直接走完", () => {
  const hand = makeHand("S7", "H7", "D7");
  const match = table({ hands: [hand, filler(12, 4), filler(12, 20), filler(12, 32)], turn: 0 });
  assert.equal(chooseAction(match, 0, 15).cardIds.length, 3);
});

test("拆牌方案不会丢牌也不会重复用牌", () => {
  const hand = makeHand(
    "S3", "H3", "D3", "C3", "S4", "H4", "D5", "C5", "S5", "H6",
    "D6", "C7", "S8", "H9", "D10", "C11", "S12", "H13", "D14", "J16", "J17"
  );
  const plan = decompose(hand, 15);
  const ids = plan.groups.flatMap((group) => group.cards.map((card) => card.id));
  assert.equal(ids.length, hand.length);
  assert.equal(new Set(ids).size, hand.length);
});

test("有自然牌可压时不浪费逢人配", () => {
  const level = 5;
  const current = parseCombo(makeHand("S8", "H8"), level);
  const match = table({
    hands: [makeHand("H5", "S9", "D9", "H10", "C10", "S3"), filler(12, 4), filler(12, 20), filler(12, 32)],
    current,
    turn: 0,
    winner: 1,
    level
  });
  const decision = chooseAction(match, 0, level);
  assert.equal(decision.action, "play");
  assert.equal(decision.cardIds.length, 2);
  assert.ok(!decision.cardIds.includes("0-H-5"));
});

test("对家只剩一张时送小单张", () => {
  const hand = makeHand("S3", "H7", "D9", "C12", "SA");
  const match = table({
    hands: [hand, filler(12, 4), makeHand("S13"), filler(12, 32)],
    turn: 0
  });
  assert.deepEqual(chooseAction(match, 0, 15).cardIds, ["0-S-3"]);
});

test("能算出场上还没露面的牌", () => {
  const match = table({
    hands: [makeHand("SA", "HA"), filler(12, 4), filler(12, 20), filler(12, 32)]
  });
  match.playedCards = makeHand("DA", "CA");
  const unseen = unseenCounts(match, 0);
  assert.equal(unseen[14], 4);
  assert.equal(isTopOfKind(parseCombo(makeHand("SA"), 15), unseen, 15), false);
  assert.equal(isTopOfKind(parseCombo(makeHand("J17"), 15), unseen, 15), true);
});

test("提示会轮流给出多种打法", () => {
  const current = parseCombo(makeHand("S5"), 15);
  const match = table({
    hands: [makeHand("S6", "S7", "SA"), filler(12, 4), filler(12, 20), filler(12, 32)],
    current,
    turn: 0,
    winner: 1
  });
  const options = suggestPlays(match, 0, 15);
  assert.ok(options.length >= 2);
  assert.equal(options.at(-1).action, "pass");
  assert.ok(options.every((item) => item.action === "pass" || item.cardIds.length > 0));
});

test("四个机器人能完整打完一局不卡死", () => {
  const match = createMatch(["甲", "乙", "丙", "丁"], { bots: [true, true, true, true] });
  startRound(match, rng(7));
  let steps = 0;
  while (match.phase === "play" && steps < 3000) {
    const result = autoAct(match, match.turn);
    assert.equal(result.ok, true, "机器人卡住了: " + (result.error ?? ""));
    steps += 1;
  }
  assert.equal(match.phase, "roundOver");
  assert.ok(steps > 10);
});
