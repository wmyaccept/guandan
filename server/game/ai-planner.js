import { isHeartLevel, rankValue } from "./cards.js";
import { TYPES, bombPower, comboKey } from "./combos.js";
import { generatePlays } from "./moves.js";

// Search exact covers of the physical cards, not merely rank counts. A bounded
// shared memo keeps a 27-card turn affordable; every fallback is a valid cover.
// This searches generated candidates, not every possible legal partition.
export function createPlanner(hand, levelRank, fallback, budget = 2400) {
  const bits = new Map(hand.map((card, i) => [card.id, 2 ** i]));
  const full = 2 ** hand.length - 1;
  const maskOf = (cards) => cards.reduce((mask, card) => mask | bits.get(card.id), 0);
  const seen = new Map();
  const add = (combo) => {
    const mask = maskOf(combo.cards);
    const key = mask + ":" + comboKey(combo);
    if (!seen.has(key)) seen.set(key, { combo, mask });
  };
  // Reverse order preserves additional suit choices and full-house attachments
  // discarded by the old rank-only deduplication. Never truncate away bombs.
  for (const cards of [hand, hand.slice().reverse()]) {
    for (const combo of generatePlays(cards, levelRank)) add(combo);
  }
  const cost = (group) => 1 - (bombPower(group) ? 0.32 : 0);
  const planOf = (groups) => ({ groups, tricks: groups.length, score: groups.reduce((n, g) => n + cost(g), 0) });
  const byBit = hand.map((_, i) => [...seen.values()].filter((x) => x.mask & 2 ** i)
    .sort((a, b) => b.combo.length - a.combo.length || cost(a.combo) - cost(b.combo)));
  const memo = new Map([[0, planOf([])]]);
  let nodes = 0;
  function solve(mask) {
    if (memo.has(mask)) return memo.get(mask);
    const cards = hand.filter((_, i) => mask & 2 ** i);
    let best = planOf(fallback(cards, levelRank).groups);
    if (best.tricks <= 1 || nodes >= budget) {
      memo.set(mask, best);
      return best;
    }
    nodes += 1;
    // Branch on the first remaining physical card to avoid permutation search.
    const i = Math.log2(mask & -mask);
    for (const entry of byBit[i]) {
      if ((entry.mask & mask) !== entry.mask) continue;
      const rest = solve(mask ^ entry.mask);
      const score = cost(entry.combo) + rest.score;
      if (score < best.score - 1e-9) best = { groups: [entry.combo, ...rest.groups], tricks: rest.tricks + 1, score };
      if (nodes >= budget) break;
    }
    memo.set(mask, best);
    return best;
  }
  return { candidates: [...seen.values()].map((x) => x.combo), plan: () => solve(full),
    after: (cards) => solve(full ^ maskOf(cards)), get nodes() { return nodes; } };
}

// Probability bound for a natural higher group being in either opponent's
// hand, using only public counts. Wilds are pessimistically treated as potential
// supplements. This is an estimate, not proof that a card is unbeatable.
export function controlEstimate(combo, unseen, opponentCounts, levelRank, unseenWilds) {
  const copies = { [TYPES.SINGLE]: 1, [TYPES.PAIR]: 2, [TYPES.TRIPLE]: 3, [TYPES.FULL_HOUSE]: 3 }[combo.type];
  if (!copies) {
    if (combo.type === TYPES.JOKER_BOMB) return 1;
    return bombPower(combo) ? 0.82 : 0.3;
  }
  const total = Object.values(unseen).reduce((a, b) => a + b, 0);
  let risk = 0;
  for (let rank = 3; rank <= 17; rank += 1) {
    if (rankValue(rank, levelRank) <= rankValue(combo.rank, levelRank)) continue;
    const available = unseen[rank] ?? 0;
    const need = Math.max(1, copies - (rank <= 15 ? unseenWilds : 0));
    if (available < need) continue;
    for (const count of opponentCounts) {
      if (count < combo.length) continue;
      // Union bound over subsets; intentionally conservative for pairs/triples.
      let probability = 1;
      for (let k = 0; k < need; k += 1) probability *= (available - k) * (count - k) / ((k + 1) * Math.max(1, total - k));
      risk += probability;
    }
  }
  return Math.max(0, 1 - Math.min(1, risk));
}

export function unknownWilds(match, seat, levelRank) {
  return Math.max(0, 2 - [...match.hands[seat], ...(match.playedCards ?? [])]
    .filter((card) => isHeartLevel(card, levelRank)).length);
}
