import { isHeartLevel, isJoker } from "./cards.js";
import { TYPES, parseCombo, canBeat, bombPower } from "./combos.js";

function byRankMap(hand) {
  const map = Object.create(null);
  for (const card of hand) {
    if (!map[card.rank]) map[card.rank] = [];
    map[card.rank].push(card);
  }
  return map;
}

function takeCards(byRank, wilds, rank, n, used) {
  const picked = [];
  const pickedIds = new Set();
  for (const card of byRank[rank] ?? []) {
    if (picked.length >= n) break;
    if (used.has(card.id)) continue;
    picked.push(card);
    pickedIds.add(card.id);
  }
  // Wilds also sit in byRank, so skip any wild already picked above.
  for (const card of wilds) {
    if (picked.length >= n) break;
    if (used.has(card.id) || pickedIds.has(card.id)) continue;
    picked.push(card);
    pickedIds.add(card.id);
  }
  if (picked.length < n) return null;
  return picked;
}

function withUsed(used, cards) {
  const next = new Set(used);
  for (const card of cards) next.add(card.id);
  return next;
}

function pushCombo(out, seen, cards, levelRank, current, preferred) {
  const combo = parseCombo(cards, levelRank, preferred);
  if (!combo || !canBeat(combo, current)) return;
  const key = `${combo.type}:${combo.cards.map((card) => card.id).sort().join(",")}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(combo);
}

function findSuitRank(hand, suit, rank, used) {
  return hand.find((card) => card.suit === suit && card.rank === rank && !used.has(card.id));
}

export function generatePlays(hand, levelRank, current = null) {
  const out = [];
  const seen = new Set();
  const wilds = hand.filter((card) => isHeartLevel(card, levelRank));
  const byRank = byRankMap(hand);

  const consider = (cards, preferred) => pushCombo(out, seen, cards, levelRank, current, preferred);

  for (let rank = 3; rank <= 15; rank += 1) {
    for (let n = 1; n <= 10; n += 1) {
      const cards = takeCards(byRank, wilds, rank, n, new Set());
      if (!cards) break;
      consider(cards);
    }
  }

  const jokers = hand.filter(isJoker);
  if (jokers.length === 4) consider(jokers, TYPES.JOKER_BOMB);
  for (const card of jokers) consider([card]);
  const small = jokers.filter((card) => card.rank === 16);
  const big = jokers.filter((card) => card.rank === 17);
  if (small.length >= 2) consider(small.slice(0, 2));
  if (big.length >= 2) consider(big.slice(0, 2));

  for (let triple = 3; triple <= 15; triple += 1) {
    for (let pair = 3; pair <= 15; pair += 1) {
      if (triple === pair) continue;
      const used = new Set();
      const t = takeCards(byRank, wilds, triple, 3, used);
      if (!t) continue;
      const p = takeCards(byRank, wilds, pair, 2, withUsed(used, t));
      if (!p) continue;
      consider(t.concat(p), TYPES.FULL_HOUSE);
    }
  }

  for (let start = 3; start <= 10; start += 1) {
    const used = new Set();
    const cards = [];
    let ok = true;
    for (let rank = start; rank < start + 5; rank += 1) {
      const piece = takeCards(byRank, wilds, rank, 1, used);
      if (!piece) {
        ok = false;
        break;
      }
      piece.forEach((card) => used.add(card.id));
      cards.push(piece[0]);
    }
    if (ok) consider(cards, TYPES.STRAIGHT);
  }

  for (const suit of ["S", "H", "D", "C"]) {
    for (let start = 3; start <= 10; start += 1) {
      const used = new Set();
      const cards = [];
      let ok = true;
      for (let rank = start; rank < start + 5; rank += 1) {
        const exact = findSuitRank(hand, suit, rank, used);
        const wild = wilds.find((card) => !used.has(card.id) && card !== exact);
        const pick = exact ?? wild;
        if (!pick) {
          ok = false;
          break;
        }
        used.add(pick.id);
        cards.push(pick);
      }
      if (ok) consider(cards, TYPES.FLUSH_STRAIGHT);
    }
  }

  // House rule: a pair sequence is exactly three pairs (six cards).
  for (let run = 3; run <= 3; run += 1) {
    for (let start = 3; start <= 15 - run; start += 1) {
      const used = new Set();
      const cards = [];
      let ok = true;
      for (let rank = start; rank < start + run; rank += 1) {
        const piece = takeCards(byRank, wilds, rank, 2, used);
        if (!piece) {
          ok = false;
          break;
        }
        piece.forEach((card) => used.add(card.id));
        cards.push(...piece);
      }
      if (ok) consider(cards, TYPES.PAIR_SEQ);
    }
  }

  // House rule: a steel plate is exactly two triples (six cards).
  for (let run = 2; run <= 2; run += 1) {
    for (let start = 3; start <= 15 - run; start += 1) {
      const used = new Set();
      const cards = [];
      let ok = true;
      for (let rank = start; rank < start + run; rank += 1) {
        const piece = takeCards(byRank, wilds, rank, 3, used);
        if (!piece) {
          ok = false;
          break;
        }
        piece.forEach((card) => used.add(card.id));
        cards.push(...piece);
      }
      if (ok) consider(cards, TYPES.TRIPLE_SEQ);
    }
  }

  return out.sort((a, b) => {
    const bombDiff = bombPower(a) - bombPower(b);
    if (bombDiff !== 0) return bombDiff;
    if (a.length !== b.length) return a.length - b.length;
    return (a.value ?? a.rank) - (b.value ?? b.rank);
  });
}
