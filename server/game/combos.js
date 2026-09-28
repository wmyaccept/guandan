import {
  SEQ_TOP,
  SUIT_SYMBOL,
  isHeartLevel,
  isJoker,
  levelLabel,
  pointValue,
  rankAtPosition,
  rankValue
} from "./cards.js";

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
  [TYPES.PAIR_SEQ]: "木板",
  [TYPES.TRIPLE_SEQ]: "钢板",
  [TYPES.BOMB]: "炸弹",
  [TYPES.FLUSH_STRAIGHT]: "同花顺",
  [TYPES.JOKER_BOMB]: "天王炸"
};

const RUN_TYPES = new Set([
  TYPES.STRAIGHT,
  TYPES.PAIR_SEQ,
  TYPES.TRIPLE_SEQ,
  TYPES.FLUSH_STRAIGHT
]);

// Runs keep their natural top card for comparison; every other combo uses the
// level-aware order so a level card outranks A and a plain 2 stays weakest.
function compareValue(item, levelRank) {
  if (RUN_TYPES.has(item.type)) return item.rank;
  return rankValue(item.rank, levelRank);
}

function comboValueOf(item) {
  return item.value ?? item.rank;
}

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
    run: extra.run ?? 0,
    start: extra.start ?? 0,
    pairRank: extra.pairRank ?? 0,
    suit: extra.suit ?? ""
  };
}

// onlyRank pins the reading to one rank: a lone wild card is worth exactly the
// level it copies, so it must not fan out into a dozen "single" readings.
function collectSameRank(cards, counts, wilds, copies, type, onlyRank = 0) {
  const found = [];
  if (cards.length !== copies) return found;
  const maxRank = copies <= 2 ? 17 : 15;
  const from = onlyRank || 3;
  const to = onlyRank || maxRank;
  for (let rank = from; rank <= to; rank += 1) {
    if (rank >= 16 && wilds > 0) continue;
    const have = counts[rank] ?? 0;
    if (have > copies) continue;
    if (have + wilds === copies && leftoverNaturals(counts, { [rank]: have })) {
      found.push(combo(type, cards, rank, { copies }));
    }
  }
  return found;
}

function collectBombs(cards, counts, wilds) {
  const found = [];
  if (cards.length < 4) return found;
  if (cards.length === 4 && cards.every(isJoker)) {
    found.push(combo(TYPES.JOKER_BOMB, cards, 17, { bombSize: 11, bombPower: 900 }));
    return found;
  }
  if (cards.some(isJoker)) return found;
  for (let rank = 3; rank <= 15; rank += 1) {
    const have = counts[rank];
    if (have === 0 && wilds !== cards.length) continue;
    if (have + wilds === cards.length && leftoverNaturals(counts, { [rank]: have })) {
      found.push(combo(TYPES.BOMB, cards, rank, {
        copies: cards.length,
        bombSize: cards.length,
        bombPower: cards.length * 10
      }));
    }
  }
  return found;
}

function collectRuns(cards, counts, wilds, copies, runLen, type) {
  const found = [];
  if (cards.length !== copies * runLen) return found;
  if (Object.keys(counts).some((rank) => Number(rank) >= 16 && counts[rank] > 0)) return found;
  // combo.rank 记的是这手连牌的最高“位置”，A 当小时最高位是 5，所以
  // A2345 < 23456 < ... < 10JQKA，比较时不会被级牌抬起来。
  for (let start = 1; start + runLen - 1 <= SEQ_TOP; start += 1) {
    const consume = {};
    let need = 0;
    let valid = true;
    for (let offset = 0; offset < runLen; offset += 1) {
      const rank = rankAtPosition(start + offset);
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
      found.push(combo(type, cards, start + runLen - 1, {
        copies,
        run: runLen,
        start
      }));
    }
  }
  return found;
}

function collectFullHouses(cards, counts, wilds) {
  const found = [];
  if (cards.length !== 5) return found;
  for (let triple = 3; triple <= 15; triple += 1) {
    // 带的一对可以是一对王（小王小王 / 大王大王），王必须是真牌，逢人配变不出来
    for (let pair = 3; pair <= 17; pair += 1) {
      if (triple === pair) continue;
      const havePair = counts[pair] ?? 0;
      if (pair >= 16 && havePair !== 2) continue;
      const needTriple = Math.max(0, 3 - (counts[triple] ?? 0));
      const needPair = Math.max(0, 2 - havePair);
      if ((counts[triple] ?? 0) > 3 || havePair > 2) continue;
      if (needTriple + needPair > wilds) continue;
      if (leftoverNaturals(counts, {
        [triple]: Math.min(3, counts[triple] ?? 0),
        [pair]: Math.min(2, havePair)
      })) {
        found.push(combo(TYPES.FULL_HOUSE, cards, triple, {
          copies: 3,
          pairRank: pair
        }));
      }
    }
  }
  return found;
}

function collectFlushStraights(cards, counts, wilds, naturalCards) {
  const found = [];
  if (cards.length !== 5) return found;
  if (naturalCards.some(isJoker)) return found;
  const suitGroups = { S: 0, H: 0, D: 0, C: 0 };
  for (const card of naturalCards) suitGroups[card.suit] += 1;
  const usedSuits = Object.entries(suitGroups).filter(([, n]) => n > 0);
  if (usedSuits.length > 1) return found;
  const suit = usedSuits.length === 1 ? usedSuits[0][0] : "H";
  for (const run of collectRuns(cards, counts, wilds, 1, 5, TYPES.FLUSH_STRAIGHT)) {
    found.push(combo(TYPES.FLUSH_STRAIGHT, cards, run.rank, {
      copies: 1,
      run: 5,
      start: run.start,
      bombSize: 5,
      bombPower: 55,
      suit
    }));
  }
  return found;
}

function interpretationsForSplit(cards, naturalCards, wilds, levelRank) {
  const { counts } = countNaturals(naturalCards);
  const found = [];
  const addAll = (items) => {
    for (const item of items) found.push(item);
  };

  const loneWild = cards.length === 1 && wilds === 1 && naturalCards.length === 0;
  addAll(collectSameRank(cards, counts, wilds, 1, TYPES.SINGLE, loneWild ? levelRank : 0));
  addAll(collectSameRank(cards, counts, wilds, 2, TYPES.PAIR));
  addAll(collectSameRank(cards, counts, wilds, 3, TYPES.TRIPLE));
  addAll(collectFullHouses(cards, counts, wilds));
  addAll(collectRuns(cards, counts, wilds, 1, 5, TYPES.STRAIGHT));
  // House rule: pair sequences are exactly three pairs and steel plates
  // exactly two triples, so both shapes are six cards and nothing longer.
  if (cards.length === 6) {
    addAll(collectRuns(cards, counts, wilds, 2, 3, TYPES.PAIR_SEQ));
    addAll(collectRuns(cards, counts, wilds, 3, 2, TYPES.TRIPLE_SEQ));
  }
  addAll(collectFlushStraights(cards, counts, wilds, naturalCards));
  addAll(collectBombs(cards, counts, wilds));
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
    for (const item of interpretationsForSplit(cards, naturalCards, wilds, levelRank)) {
      item.value = compareValue(item, levelRank);
      const key = comboKey(item);
      if (!unique.has(key)) unique.set(key, item);
    }
  }
  return [...unique.values()];
}

export function comboKey(item) {
  if (!item) return "";
  return [
    item.type,
    item.rank,
    item.length,
    item.copies,
    item.bombPower,
    item.run,
    item.start,
    item.pairRank,
    item.suit
  ].join(":");
}

export function parseCombo(cards, levelRank, preferredType = null, preferredKey = null) {
  const found = parseCombos(cards, levelRank);
  if (!found.length) return null;
  if (preferredKey) return found.find((item) => comboKey(item) === preferredKey) ?? null;
  if (preferredType) {
    const match = found.find((item) => item.type === preferredType);
    if (match) return match;
  }
  return found.slice().sort((a, b) => {
    if (a.bombPower !== b.bombPower) return b.bombPower - a.bombPower;
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return comboValueOf(b) - comboValueOf(a);
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
    return comboValueOf(next) > comboValueOf(current);
  }
  if (nextBomb) return true;
  if (currentBomb) return false;
  if (next.type !== current.type) return false;
  if (next.length !== current.length) return false;
  return comboValueOf(next) > comboValueOf(current);
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
      const key = combo.cards.map((card) => card.id).sort().join(",") + comboKey(combo);
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

function runDetail(item) {
  const parts = [];
  for (let offset = 0; offset < item.run; offset += 1) {
    const rank = rankAtPosition(item.start + offset);
    const label = levelLabel(rank);
    parts.push(item.copies === 2 ? label + label : item.copies === 3 ? label + label + label : label);
  }
  return parts.join("");
}

export function comboLabel(combo, levelRank) {
  if (!combo) return "";
  if (combo.type === TYPES.JOKER_BOMB) return "天王炸";
  if (combo.type === TYPES.BOMB) return `${combo.length}炸`;
  if (combo.type === TYPES.FLUSH_STRAIGHT) return "同花顺";
  return combo.label;
}

export function comboOption(item) {
  if (!item) return null;
  let detail = comboLabel(item);
  if (item.type === TYPES.SINGLE) detail = levelLabel(item.rank);
  if (item.type === TYPES.PAIR) detail = levelLabel(item.rank) + "对";
  if (item.type === TYPES.TRIPLE) detail = levelLabel(item.rank) + "三张";
  if (item.type === TYPES.FULL_HOUSE) {
    detail = levelLabel(item.rank) + "三张 + " + levelLabel(item.pairRank) + "一对";
  }
  if (item.type === TYPES.STRAIGHT) detail = runDetail(item);
  if (item.type === TYPES.PAIR_SEQ) detail = runDetail(item) + " 连对";
  if (item.type === TYPES.TRIPLE_SEQ) detail = runDetail(item) + " 钢板";
  if (item.type === TYPES.FLUSH_STRAIGHT) {
    detail = (SUIT_SYMBOL[item.suit] ?? "") + runDetail(item) + " 同花";
  }
  if (item.type === TYPES.BOMB) detail = item.length + "张" + levelLabel(item.rank);
  if (item.type === TYPES.JOKER_BOMB) detail = "小王小王 + 大王大王";
  return {
    key: comboKey(item),
    type: item.type,
    label: comboLabel(item),
    detail,
    cards: item.cards.map((card) => card.id)
  };
}

export function smallestLead(hand, levelRank) {
  const singles = hand
    .map((card) => parseCombo([card], levelRank))
    .filter(Boolean)
    .sort((a, b) => pointValue(a.cards[0], levelRank) - pointValue(b.cards[0], levelRank));
  return singles[0] ?? parseCombo(hand.slice(0, 1), levelRank);
}
