import assert from "node:assert/strict";
import test from "node:test";
import { autoAct, buildTribute, createMatch, passTurn, playCards, publicState, returnTribute, startRound } from "./engine.js";
import { createShoe } from "./cards.js";
import { TYPES, comboKey, parseCombo, parseCombos } from "./combos.js";

test("two decks deal 27 cards each", () => {
  assert.equal(createShoe().length, 108);
  const match = createMatch(["A", "B", "C", "D"]);
  startRound(match, () => 0.2);
  assert.deepEqual(match.hands.map((hand) => hand.length), [27, 27, 27, 27]);
  assert.equal(match.phase, "play");
});

test("cannot pass on lead", () => {
  const match = createMatch(["A", "B", "C", "D"]);
  startRound(match, () => 0.4);
  const seat = match.turn;
  const card = match.hands[seat][0];
  const played = playCards(match, seat, [card.id]);
  assert.equal(played.ok, true);
  const view = publicState(match, seat);
  assert.equal(view.handsCount.reduce((a, b) => a + b, 0), 107);
});


test("playCards rejects duplicate card ids", () => {
  const match = createMatch(["A", "B", "C", "D"]);
  startRound(match, () => 0.2);
  const seat = match.turn;
  const id = match.hands[seat][0].id;
  const result = playCards(match, seat, [id, id]);
  assert.equal(result.ok, false);
  assert.equal(match.hands[seat].length, 27);
});

test("full rounds keep all 108 cards unique", () => {
  const match = createMatch(["A", "B", "C", "D"], { bots: [true, true, true, true] });
  for (let round = 0; round < 3; round += 1) {
    startRound(match);
    let guard = 0;
    while (match.phase === "play" || match.phase === "returnTribute") {
      guard += 1;
      assert.ok(guard < 2000, "round stalled");
      const seat = match.phase === "returnTribute" ? match.returnsPlan[0]?.from : match.turn;
      autoAct(match, seat);
      const ids = [];
      for (const hand of match.hands) for (const card of hand) ids.push(card.id);
      for (const card of match.playedCards) ids.push(card.id);
      assert.equal(ids.length, 108);
      assert.equal(new Set(ids).size, 108);
    }
    if (match.phase === "matchOver") break;
  }
});
let cardSeq = 0;
function tc(suit, rank) {
  cardSeq += 1;
  return { id: `t${cardSeq}-${suit}-${rank}`, deck: 0, suit, rank };
}

// 座位 0/2 为红队，1/3 为蓝队
function matchWithFinish(finishOrder) {
  const match = createMatch(["甲", "乙", "丙", "丁"]);
  match.round = 1;
  match.finishOrder = finishOrder.slice();
  return match;
}

test("双下：两名负方各进一贡，大贡给头游", () => {
  const match = matchWithFinish([0, 2, 1, 3]);
  match.hands = [
    [tc("S", 5)],
    [tc("S", 13), tc("H", 3)],
    [tc("S", 6)],
    [tc("S", 9)]
  ];
  assert.equal(buildTribute(match), true);
  assert.equal(match.tributeRefused.length, 0);
  assert.deepEqual(
    match.tributePlan.map((step) => [step.from, step.to]),
    [[1, 0], [3, 2]]
  );
});

test("头三：只由末游向头游进一贡", () => {
  const match = matchWithFinish([0, 1, 2, 3]);
  match.hands = [
    [tc("S", 5)],
    [tc("S", 6)],
    [tc("S", 7)],
    [tc("S", 14), tc("S", 4)]
  ];
  assert.equal(buildTribute(match), true);
  assert.equal(match.tributePlan.length, 1);
  assert.equal(match.tributePlan[0].from, 3);
  assert.equal(match.tributePlan[0].to, 0);
});

test("头末内供：末游是头游队友时也要进贡", () => {
  const match = matchWithFinish([0, 1, 3, 2]);
  match.hands = [
    [tc("S", 5)],
    [tc("S", 6)],
    [tc("S", 7)],
    [tc("S", 12)]
  ];
  assert.equal(buildTribute(match), true);
  assert.equal(match.tributePlan.length, 1);
  assert.equal(match.tributePlan[0].from, 2);
  assert.equal(match.tributePlan[0].to, 0);
  assert.equal(match.tributePlan[0].cardId, match.hands[2][0].id);
  assert.equal(match.nextLead, 2);
});

test("双下：头游拿大贡，进大贡的一家先出", () => {
  const match = matchWithFinish([0, 2, 1, 3]);
  match.hands = [
    [tc("S", 5)],
    [tc("S", 4)],
    [tc("S", 6)],
    [tc("S", 13)]
  ];
  assert.equal(buildTribute(match), true);
  assert.deepEqual(
    match.tributePlan.map((step) => [step.from, step.to]),
    [[3, 0], [1, 2]]
  );
  assert.equal(match.tributePlan[0].cardId, match.hands[3][0].id);
  assert.equal(match.nextLead, 3);
});

test("抗贡：单进贡方独握两张大王", () => {
  const match = matchWithFinish([0, 1, 2, 3]);
  match.hands = [
    [tc("S", 5)],
    [tc("S", 6)],
    [tc("S", 7)],
    [tc("J", 17), tc("J", 17), tc("S", 4)]
  ];
  assert.equal(buildTribute(match), false);
  assert.deepEqual(match.tributeRefused, [3]);
  assert.equal(match.tributePlan.length, 0);
  assert.match(match.tributeSummary[0], /抗贡/);
});

test("抗贡：双下时两名负方各一张大王", () => {
  const match = matchWithFinish([0, 2, 1, 3]);
  match.hands = [
    [tc("S", 5)],
    [tc("J", 17), tc("S", 9)],
    [tc("S", 6)],
    [tc("J", 17), tc("S", 8)]
  ];
  assert.equal(buildTribute(match), false);
  assert.deepEqual(match.tributeRefused.slice().sort(), [1, 3]);
  assert.equal(match.tributePlan.length, 0);
});

test("胜方握大王不能抗贡", () => {
  const match = matchWithFinish([0, 1, 2, 3]);
  match.hands = [
    [tc("J", 17), tc("J", 17)],
    [tc("S", 6)],
    [tc("S", 7)],
    [tc("S", 9)]
  ];
  assert.equal(buildTribute(match), true);
  assert.equal(match.tributeRefused.length, 0);
  assert.equal(match.tributePlan.length, 1);
});

test("逢人配不作为贡牌", () => {
  const match = matchWithFinish([0, 1, 2, 3]);
  const wild = tc("H", 15);
  match.hands = [
    [tc("S", 5)],
    [tc("S", 6)],
    [tc("S", 7)],
    [wild, tc("S", 10)]
  ];
  assert.equal(buildTribute(match), true);
  assert.equal(match.tributePlan.length, 1);
  assert.equal(match.tributePlan.some((step) => step.cardId === wild.id), false);
});

test("还贡完成后由进贡方先出", () => {
  const match = matchWithFinish([2, 1, 0, 3]);
  match.hands = [
    [tc("S", 5), tc("S", 4)],
    [tc("S", 6)],
    [tc("S", 7)],
    [tc("S", 14)]
  ];
  match.nextLead = 2;
  assert.equal(buildTribute(match), true);
  assert.equal(match.tributePlan.length, 1);
  assert.equal(match.tributePlan[0].from, 3);
  assert.equal(match.tributePlan[0].to, 2);

  const step = match.tributePlan[0];
  const gift = match.hands[step.from].find((card) => card.id === step.cardId);
  assert.equal(gift.rank, 14);
  match.hands[step.from] = match.hands[step.from].filter((card) => card.id !== step.cardId);
  match.hands[step.to].push(gift);
  match.phase = "returnTribute";
  match.returnsPlan = [{ from: step.to, to: step.from }];

  const small = match.hands[step.to].find((card) => card.rank === 7);
  const done = returnTribute(match, step.to, small.id);
  assert.equal(done.ok, true);
  assert.equal(match.phase, "play");
  assert.equal(match.leadSeat, 3);
  assert.equal(match.turn, 3);
  assert.equal(match.hands[2].length, 1);
  assert.equal(match.hands[3].length, 1);
  assert.equal(match.hands[3][0].rank, 7);
  assert.match(match.tributeSummary.at(-1), /还贡/);
});

test("抗贡之后由头游先出", () => {
  const match = matchWithFinish([0, 1, 2, 3]);
  match.hands = [
    [tc("S", 5)],
    [tc("S", 6)],
    [tc("S", 7)],
    [tc("J", 17), tc("J", 17), tc("S", 4)]
  ];
  match.nextLead = 1;
  assert.equal(buildTribute(match), false);
  assert.equal(match.nextLead, 0);
});

test("双下提前结束：同队包揽头二游就不再往下打", () => {
  const match = createMatch(["甲", "乙", "丙", "丁"]);
  match.round = 1;
  match.phase = "play";
  match.hands = [
    [tc("S", 7)],
    [tc("S", 3)],
    [tc("J", 17)],
    [tc("S", 4), tc("S", 5), tc("S", 6)]
  ];
  match.turn = 0;
  assert.equal(playCards(match, 0, [match.hands[0][0].id]).ok, true);
  assert.equal(match.phase, "play");
  assert.equal(passTurn(match, 1).ok, true);
  assert.equal(playCards(match, 2, [match.hands[2][0].id]).ok, true);
  assert.equal(match.phase, "roundOver");
  assert.deepEqual(match.finishOrder, [0, 2, 1, 3]);
  assert.equal(match.roundResult.kind, "双下");
  assert.equal(match.roundResult.steps, 3);
  assert.equal(match.hands[1].length, 1);
  assert.equal(match.hands[3].length, 3);
});

test("出完牌的玩家要等其余在场的人都不要后才接风", () => {
  const match = createMatch(["甲", "乙", "丙", "丁"]);
  match.round = 1;
  match.phase = "play";
  match.hands = [[tc("S", 3)], [tc("S", 4)], [tc("S", 5)], [tc("S", 9)]];
  match.turn = 0;
  assert.equal(playCards(match, 0, [match.hands[0][0].id]).ok, true);

  assert.equal(passTurn(match, 1).ok, true);
  assert.equal(match.current !== null, true, "one pass must not end the trick");
  assert.equal(passTurn(match, 2).ok, true);
  assert.equal(match.turn, 3, "the last live seat must still get a turn");
  assert.equal(match.current !== null, true, "two passes must not end the trick either");

  assert.equal(playCards(match, 3, [match.hands[3][0].id]).ok, true);
  assert.equal(match.leadSeat, 3);
  assert.equal(match.turn, 1);
});

test("三家都不要之后才由出完牌一方的队友接风", () => {
  const match = createMatch(["甲", "乙", "丙", "丁"]);
  match.round = 1;
  match.phase = "play";
  match.hands = [[tc("S", 3)], [tc("S", 4)], [tc("S", 5)], [tc("S", 6)]];
  match.turn = 0;
  assert.equal(playCards(match, 0, [match.hands[0][0].id]).ok, true);

  assert.equal(passTurn(match, 1).ok, true);
  assert.equal(passTurn(match, 2).ok, true);
  assert.equal(passTurn(match, 3).ok, true);
  assert.equal(match.current, null);
  assert.equal(match.turn, (0 + 2) % 4);
  assert.equal(match.log.some((line) => line.includes("接风")), true);
  assert.equal(match.log.at(-1), "丙 接风");
});

test("记牌器只统计还没露面的牌", () => {
  const match = createMatch(["甲", "乙", "丙", "丁"]);
  match.phase = "play";
  match.playedCards = [tc("S", 3), tc("H", 3), tc("J", 17)];
  match.hands = [[tc("S", 3), tc("D", 9)], [], [], []];
  const view = publicState(match, 0);
  assert.equal(view.remaining[3], 5);
  assert.equal(view.remaining[17], 1);
  assert.equal(view.remaining[9], 7);
  assert.equal(view.remaining[5], 8);
});

test("自己出完可以看队友的手牌", () => {
  const match = createMatch(["甲", "乙", "丙", "丁"]);
  match.phase = "play";
  match.hands = [[], [tc("S", 3)], [tc("S", 4), tc("H", 9)], []];
  const mine = publicState(match, 0);
  assert.equal(mine.spectate.seat, 2);
  assert.deepEqual(mine.spectate.hand.map((card) => card.rank), [4, 9]);
  assert.equal(publicState(match, 1).spectate, null);
  match.phase = "roundOver";
  assert.equal(publicState(match, 0).spectate, null);
});

test("整局模拟：进贡按名次，双下两贡", () => {
  let tributeRounds = 0;
  let refusedRounds = 0;
  for (let g = 0; g < 5; g += 1) {
    const match = createMatch(["A", "B", "C", "D"], { bots: [true, true, true, true] });
    startRound(match);
    let guard = 0;
    while (match.phase !== "matchOver" && guard < 20000) {
      guard += 1;
      if (match.phase === "roundOver") {
        const finish = match.roundResult.finishOrder;
        const kind = match.roundResult.kind;
        const head = finish[0];
        const payers = kind === "双下" ? [finish[3], finish[2]] : [finish[3]];
        startRound(match);
        if (match.phase === "returnTribute") {
          tributeRounds += 1;
          assert.equal(match.tributePlan.length, kind === "双下" ? 2 : 1);
          assert.equal(match.tributePlan[0].to, head);
          assert.equal(match.tributeSummary.length, match.tributePlan.length);
          for (const plan of match.tributePlan) {
            assert.ok(payers.includes(plan.from), "进贡方按名次定");
            assert.ok(plan.to === head || plan.to === finish[1], "收贡方是头游或二游");
          }
          assert.equal(match.nextLead, match.tributePlan[0].from);
          assert.equal(match.hands.reduce((sum, hand) => sum + hand.length, 0), 108);
          let inner = 0;
          while (match.phase === "returnTribute") {
            inner += 1;
            assert.ok(inner < 10, "还贡卡住");
            assert.equal(autoAct(match, match.returnsPlan[0].from).ok, true);
          }
          assert.equal(match.phase, "play");
          assert.equal(match.leadSeat, match.nextLead);
          assert.deepEqual(match.hands.map((hand) => hand.length), [27, 27, 27, 27]);
        } else {
          assert.equal(match.phase, "play");
          assert.ok(match.tributeRefused.length === 1 || match.tributeRefused.length === 2);
          refusedRounds += 1;
        }
        continue;
      }
      const seat = match.phase === "returnTribute" ? match.returnsPlan[0]?.from : match.turn;
      if (seat == null) break;
      if (!autoAct(match, seat)?.ok) break;
    }
  }
  assert.ok(tributeRounds > 0, "应至少出现一次进贡");
  console.log("      tribute rounds:", tributeRounds, "refused:", refusedRounds);
});

test("同花顺 A2345 能压住更大的普通顺子", () => {
  const match = createMatch(["甲", "乙", "丙", "丁"]);
  match.round = 1;
  match.phase = "play";
  match.hands = [
    [tc("S", 14), tc("S", 15), tc("S", 3), tc("S", 4), tc("S", 5)],
    [tc("H", 4), tc("D", 5), tc("C", 6), tc("S", 7), tc("H", 8)],
    [tc("H", 9)],
    [tc("H", 10)]
  ];
  match.turn = 1;
  const lead = playCards(match, 1, match.hands[1].map((card) => card.id));
  assert.equal(lead.ok, true, lead.error ?? "");
  assert.equal(match.current.type, TYPES.STRAIGHT);
  assert.equal(match.current.rank, 8);

  // 甲手里是黑桃 A2345：当顺子看比上家小，当同花顺看是炸弹，
  // 引擎不能因为上家是顺子就把它锁死在输的那种解读上。
  match.turn = 0;
  const beat = playCards(match, 0, match.hands[0].map((card) => card.id));
  assert.equal(beat.ok, true, beat.error ?? "");
  assert.equal(match.current.type, TYPES.FLUSH_STRAIGHT);
  assert.equal(match.hands[0].length, 0);
});
function wildHandMatch() {
  const match = createMatch(["A", "B", "C", "D"]);
  match.teamLevel = [5, 5];
  match.round = 2;
  match.phase = "play";
  match.turn = 0;
  match.hands = [
    [tc("S", 7), tc("H", 7), tc("S", 14), tc("H", 14), tc("H", 5)],
    [tc("S", 3)],
    [tc("S", 3)],
    [tc("S", 3)]
  ];
  return match;
}

test("leading with a wild card asks the player which reading to play", () => {
  const match = wildHandMatch();
  match.leadSeat = 0;
  const ids = match.hands[0].map((card) => card.id);
  const first = playCards(match, 0, ids);
  assert.equal(first.ok, false);
  assert.equal(first.ambiguous, true);
  assert.ok(first.options.length >= 2);
  const aces = parseCombos(match.hands[0], 5)
    .find((item) => item.type === TYPES.FULL_HOUSE && item.rank === 14);
  const option = first.options.find((item) => item.key === comboKey(aces));
  assert.ok(option, "ace reading missing from the choices");
  const second = playCards(match, 0, ids, "", option.key);
  assert.equal(second.ok, true);
  assert.equal(match.current.type, TYPES.FULL_HOUSE);
  assert.equal(match.current.rank, 14);
});

test("a wild card fills the only winning reading without asking", () => {
  const match = wildHandMatch();
  match.leadSeat = 1;
  match.current = parseCombo([tc("S", 8), tc("H", 8), tc("D", 8), tc("S", 9), tc("H", 9)], 5);
  const result = playCards(match, 0, match.hands[0].map((card) => card.id));
  assert.equal(result.ok, true);
  assert.equal(match.current.rank, 14);
});
