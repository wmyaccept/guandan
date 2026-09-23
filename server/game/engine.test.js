import assert from "node:assert/strict";
import test from "node:test";
import { autoAct, createMatch, playCards, publicState, startRound } from "./engine.js";
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
