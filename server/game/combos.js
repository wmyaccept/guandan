import { isHeartLevel, isJoker, pointValue } from "./cards.js";

export const TYPES = {
  SINGLE: "single",
  PAIR: "pair",
  TRIPLE: "triple",
  FULL_HOUSE: "fullhouse",
  STRAIGHT: "straight",
  PAIR_SEQ: "pairseq",
  TRIPLE_SEQ: "tripleseq",
  BOMB: "bomb",
  FLUSH_STRAIGHT: "flushstraight",
  JOKER_BOMB: "jokerbomb"
};

const TYPE_LABEL = {
  [TYPES.SINGLE]: "单张",
  [TYPES.PAIR]: "对子",
  [TYPES.TRIPLE]: "三张",
  [TYPES.FULL_HOUSE]: "三带二",
  [TYPES.STRAIGHT]: "顺子",
  [TYPES.PAIR_SEQ]: "连对",
  [TYPES.TRIPLE_SEQ]: "钢板",
  [TYPES.BOMB]: "炸弹",
  [TYPES.FLUSH_STRAIGHT]: "同花顺",
  [TYPES.JOKER_BOMB]: "天王炸"
};

function cloneCounts() {
  const counts = Object.create(null);
  for (let rank = 3; rank <= 17; rank += 1) counts[rank] = 0;
  return counts;
}

function countNaturals(cards) {
  const counts = cloneCounts();
  const suits = Object.create(null);
  for (const card of cards) {
    counts[card.rank] += 1;
    if (!suits[card.rank]) suits[card.rank] = [];
    suits[card.rank].push(card.suit);
  }
  return { counts, suits };
}

function leftoverNaturals(counts, consume) {
  for (const [rank, amount] of Object.entries(consume)) {
    if ((counts[Number(rank)] ?? 0) < amount) return false;
  }
  let used = 0;
  for (const amount of Object.values(consume)) used += amount;
  let total = 0;
  for (let rank = 3; rank <= 17; rank += 1) total += counts[rank];
  return used === total;
}

function needWilds(counts, consume) {
  let need = 0;
  for (const [rank, amount] of Object.entries(consume)) {
    const have = counts[Number(rank)] ?? 0;
    if (have > amount) return Infinity;
    need += amount - have;
  }
  let consumed = 0;
  for (const amount of Object.values(consume)) consumed += amount;
  let total = 0;
  for (let rank = 3; rank <= 17; rank += 1) total += counts[rank];
  const unused = total - Object.entries(consume).reduce((sum, [rank, amount]) => {
    return sum + Math.min(amount, counts[Number(rank)] ?? 0);
  }, 0);
  if (unused > 0) return Infinity;
  return need;
}

function combo(type, cards, rank, extra = {}) {
  return {
    type,
    label: extra.label ?? TYPE_LABEL[type],
    cards,
    rank,
    length: cards.length,
    copies: extra.copies ?? 1,
    bombSize: extra.bombSize ?? 0,
    bombPower: extra.bombPower ?? 0,
    run: extra.run ?? 0
  };
}

function trySameRank(cards, counts, wilds, copies, type) {
  if (cards.length !== copies) return null;
  const maxRank = copies <= 2 ? 17 : 15;
  for (let rank = 3; rank <= maxRank; rank += 1) {
    if (rank >= 16 && wilds > 0) continue;
    const have = counts[rank];
    if (have > copies) continue;
    if (have + wilds === copies && leftoverNaturals(counts, { [rank]: have })) {
      return combo(type, cards, rank, { copies });
    }
  }
  return null;
}

function tryBomb(cards, counts, wilds) {
  if (cards.length < 4) return null;
  if (cards.length === 4 && cards.every(isJoker)) {
    return combo(TYPES.JOKER_BOMB, cards, 17, { bombSize: 11, bombPower: 900 });
  }
  if (cards.some(isJoker)) return null;
  for (let rank = 3; rank <= 15; rank += 1) {
    const have = counts[rank];
    if (have === 0 && wilds !== cards.length) continue;
    if (have + wilds === cards.length && leftoverNaturals(counts, { [rank]: have })) {
      return combo(TYPES.BOMB, cards, rank, {
        copies: cards.length,
        bombSize: cards.length,
        bombPower: cards.length * 10
      });
    }
  }
  return null;
}

function tryRun(cards, counts, wilds, copies, runLen, type) {
  if (cards.length !== copies * runLen) return null;
  if (Object.keys(counts).some((rank) => Number(rank) >= 16 && counts[rank] > 0)) return null;
  if (counts[15] > 0) return null;
  for (let start = 3; start <= 15 - runLen; start += 1) {
    const consume = {};
    let need = 0;
    let valid = true;
    for (let offset = 0; offset < runLen; offset += 1) {
      const rank = start + offset;
      const have = counts[rank] ?? 0;
      if (have > copies) {
        valid = false;
        break;
      }
      consume[rank] = have;
      need += copies - have;
    }
    if (!valid || need > wilds) continue;
    if (leftoverNaturals(counts, consume)) {
      return combo(type, cards, start + runLen - 1, { copies, run: runLen });
    }
  }
  return null;
}

function tryFullHouse(cards, counts, wilds) {
  if (cards.length !== 5) return null;
  if (counts[16] || counts[17]) return null;
  for (let triple = 3; triple <= 15; triple += 1) {
    for (let pair = 3; pair <= 15; pair += 1) {
      if (triple === pair) continue;
      const needTriple = Math.max(0, 3 - (counts[triple] ?? 0));
      const needPair = Math.max(0, 2 - (counts[pair] ?? 0));
      if ((counts[triple] ?? 0) > 3 || (counts[pair] ?? 0) > 2) continue;
      if (needTriple + needPair > wilds) continue;
      if (leftoverNaturals(counts, {
        [triple]: Math.min(3, counts[triple] ?? 0),
        [pair]: Math.min(2, counts[pair] ?? 0)
      })) {
        return combo(TYPES.FULL_HOUSE, cards, triple, { copies: 3 });
      }
    }
  }
  return null;
}

function tryFlushStraight(cards, counts, wilds, naturalCards) {
  if (cards.length !== 5) return null;
  if (naturalCards.some(isJoker) || counts[15] > 0) return null;
  const suitGroups = { S: 0, H: 0, D: 0, C: 0 };
  for (const card of naturalCards) suitGroups[card.suit] += 1;
  const usedSuits = Object.entries(suitGroups).filter(([, n]) => n > 0);
  if (usedSuits.length > 1) return null;
  const suit = usedSuits.length === 1 ? usedSuits[0][0] : "H";
  const straight = tryRun(cards, counts, wilds, 1, 5, TYPES.FLUSH_STRAIGHT);
  if (!straight) return null;
  return combo(TYPES.FLUSH_STRAIGHT, cards, straight.rank, {
    copies: 1,
    run: 5,
    bombSize: 5,
    bombPower: 55,
    suit
  });
}

function interpretationsForSplit(cards, naturalCards, wilds) {
  const { counts } = countNaturals(naturalCards);
  const found = [];
  const add = (item) => {
    if (item) found.push(item);
  };

  add(trySameRank(cards, counts, wilds, 1, TYPES.SINGLE));
  add(trySameRank(cards, counts, wilds, 2, TYPES.PAIR));
  add(trySameRank(cards, counts, wilds, 3, TYPES.TRIPLE));
  add(tryFullHouse(cards, counts, wilds));
  add(tryRun(cards, counts, wilds, 1, 5, TYPES.STRAIGHT));
  // House rule: pair sequences are exactly three pairs and steel plates
  // exactly two triples, so both shapes are six cards and nothing longer.
  if (cards.length === 6) {
    add(tryRun(cards, counts, wilds, 2, 3, TYPES.PAIR_SEQ));
    add(tryRun(cards, counts, wilds, 3, 2, TYPES.TRIPLE_SEQ));
  }
  add(tryFlushStraight(cards, counts, wilds, naturalCards));
  add(tryBomb(cards, counts, wilds));
  return found;
}

export function parseCombos(cards, levelRank) {
  if (!cards.length) return [];
  const wildIndexes = cards
    .map((card, index) => (isHeartLevel(card, levelRank) ? index : -1))
    .filter((index) => index >= 0);
  const unique = new Map();
  const n = wildIndexes.length;
  for (let mask = 0; mask < 1 << n; mask += 1) {
    const wildSet = new Set();
    for (let i = 0; i < n; i += 1) {
      if (mask & (1 << i)) wildSet.add(wildIndexes[i]);
    }
    const naturalCards = cards.filter((_, index) => !wildSet.has(index));
    const wilds = wildSet.size;
    for (const item of interpretationsForSplit(cards, naturalCards, wilds)) {
      const key = `${item.type}-${item.rank}-${item.length}-${item.bombPower}`;
      if (!unique.has(key)) unique.set(key, item);
    }
  }
  return [...unique.values()];
}

export function parseCombo(cards, levelRank, preferredType = null) {
  const found = parseCombos(cards, levelRank);
  if (!found.length) return null;
  if (preferredType) {
    const match = found.find((item) => item.type === preferredType);
    if (match) return match;
  }
  return found.slice().sort((a, b) => {
    if (a.bombPower !== b.bombPower) return b.bombPower - a.bombPower;
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return b.rank - a.rank;
  })[0];
}

export function bombPower(combo) {
  if (!combo) return 0;
  if (combo.type === TYPES.JOKER_BOMB) return 900;
  if (combo.type === TYPES.FLUSH_STRAIGHT) return 55;
  if (combo.type === TYPES.BOMB) return combo.length * 10;
  return 0;
}

export function canBeat(next, current) {
  if (!next) return false;
  if (!current) return true;
  const nextBomb = bombPower(next);
  const currentBomb = bombPower(current);
  if (nextBomb && currentBomb) {
    if (nextBomb !== currentBomb) return nextBomb > currentBomb;
    return next.rank > current.rank;
  }
  if (nextBomb) return true;
  if (currentBomb) return false;
  if (next.type !== current.type) return false;
  if (next.length !== current.length) return false;
  return next.rank > current.rank;
}

export function legalPlays(hand, levelRank, current) {
  const plays = [];
  const seen = new Set();
  const n = hand.length;
  const limit = 1 << n;
  if (n > 16) {
    return legalPlaysHeuristic(hand, levelRank, current);
  }
  for (let mask = 1; mask < limit; mask += 1) {
    const cards = [];
    for (let i = 0; i < n; i += 1) {
      if (mask & (1 << i)) cards.push(hand[i]);
    }
    const combos = parseCombos(cards, levelRank);
    for (const combo of combos) {
      if (!canBeat(combo, current)) continue;
      const key = combo.cards.map((card) => card.id).sort().join(",") + combo.type;
      if (seen.has(key)) continue;
      seen.add(key);
      plays.push(combo);
    }
  }
  return plays;
}

function combinations(arr, k) {
  const out = [];
  const walk = (start, picked) => {
    if (picked.length === k) {
      out.push(picked.slice());
      return;
    }
    for (let i = start; i < arr.length; i += 1) {
      picked.push(arr[i]);
      walk(i + 1, picked);
      picked.pop();
    }
  };
  walk(0, []);
  return out;
}

function groupByRank(hand) {
  const groups = Object.create(null);
  for (const card of hand) {
    if (!groups[card.rank]) groups[card.rank] = [];
    groups[card.rank].push(card);
  }
  return groups;
}

function legalPlaysHeuristic(hand, levelRank, current) {
  const plays = [];
  const wilds = hand.filter((card) => isHeartLevel(card, levelRank));
  const rest = hand.filter((card) => !isHeartLevel(card, levelRank));
  const groups = groupByRank(rest);
  const tryAdd = (cards, preferred) => {
    const combo = parseCombo(cards, levelRank, preferred);
    if (combo && canBeat(combo, current)) plays.push(combo);
  };

  if (!current) {
    for (const cards of groups) for (const card of groups[cards] ?? []) tryAdd([card]);
    for (const card of hand) tryAdd([card]);
  }

  const neededLen = current?.length ?? null;
  const candidates = [];
  if (!current || current.type === TYPES.SINGLE) {
    for (const card of hand) candidates.push([card]);
  }
  for (const [rank, cards] of Object.entries(groups)) {
    for (let copies = 1; copies <= Math.min(cards.length + wilds.length, 10); copies += 1) {
      if (neededLen && copies !== neededLen && copies < 4 && !(current && bombPower(current))) continue;
      const take = cards.slice(0, Math.min(copies, cards.length));
      const need = copies - take.length;
      if (need > wilds.length) continue;
      tryAdd(take.concat(wilds.slice(0, need)));
    }
  }
  if (!current || current.type === TYPES.STRAIGHT || bombPower(current)) {
    for (const five of combinations(hand, 5).slice(0, 400)) tryAdd(five, TYPES.STRAIGHT);
  }
  return plays;
}

export function comboLabel(combo, levelRank) {
  if (!combo) return "";
  if (combo.type === TYPES.JOKER_BOMB) return "天王炸";
  if (combo.type === TYPES.BOMB) return `${combo.length}炸`;
  if (combo.type === TYPES.FLUSH_STRAIGHT) return "同花顺";
  return combo.label;
}

export function smallestLead(hand, levelRank) {
  const singles = hand
    .map((card) => parseCombo([card], levelRank))
    .filter(Boolean)
    .sort((a, b) => pointValue(a.cards[0], levelRank) - pointValue(b.cards[0], levelRank));
  return singles[0] ?? parseCombo(hand.slice(0, 1), levelRank);
}
