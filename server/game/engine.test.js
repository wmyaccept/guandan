import assert from "node:assert/strict";
import test from "node:test";
import { createMatch, playCards, publicState, startRound } from "./engine.js";
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
