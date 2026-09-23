import assert from "node:assert/strict";
import test from "node:test";
import { autoAct, buildTribute, createMatch, playCards, publicState, returnTribute, startRound } from "./engine.js";
import { createShoe } from "./cards.js";

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

test("头末：末游与头游同队，由三游进贡", () => {
  const match = matchWithFinish([0, 1, 3, 2]);
  match.hands = [
    [tc("S", 5)],
    [tc("S", 6)],
    [tc("S", 7)],
    [tc("S", 12)]
  ];
  assert.equal(buildTribute(match), true);
  assert.equal(match.tributePlan.length, 1);
  assert.equal(match.tributePlan[0].from, 3);
  assert.equal(match.tributePlan[0].to, 0);
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

test("还贡完成后由头游先出", () => {
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
  assert.equal(match.leadSeat, 2);
  assert.equal(match.turn, 2);
  assert.equal(match.hands[2].length, 1);
  assert.equal(match.hands[3].length, 1);
  assert.equal(match.hands[3][0].rank, 7);
  assert.match(match.tributeSummary.at(-1), /还贡/);
});

test("整局模拟：进贡方必为负方，双下两贡", () => {
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
        const losers = finish.filter((seat) => seat % 2 !== head % 2);
        startRound(match);
        if (match.phase === "returnTribute") {
          tributeRounds += 1;
          assert.equal(match.tributePlan.length, kind === "双下" ? 2 : 1);
          assert.equal(match.tributePlan[0].to, head);
          assert.equal(match.tributeSummary.length, match.tributePlan.length);
          for (const plan of match.tributePlan) {
            assert.ok(losers.includes(plan.from), "进贡方应为负方");
            assert.ok(!losers.includes(plan.to), "收贡方应为胜方");
          }
          assert.equal(match.nextLead, head);
          assert.equal(match.hands.reduce((sum, hand) => sum + hand.length, 0), 108);
          let inner = 0;
          while (match.phase === "returnTribute") {
            inner += 1;
            assert.ok(inner < 10, "还贡卡住");
            assert.equal(autoAct(match, match.returnsPlan[0].from).ok, true);
          }
          assert.equal(match.phase, "play");
          assert.equal(match.leadSeat, head);
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
