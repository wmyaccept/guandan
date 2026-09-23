import { isHeartLevel, pointValue } from "./cards.js";
import { TYPES, bombPower, comboLabel } from "./combos.js";
import { generatePlays } from "./moves.js";

const RANKS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
const BOMB_RANKS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const SEQ_MAX = 14;
const SUITS = ["S", "H", "D", "C"];
const MAX_CANDIDATES = 160;
const COPIES_BY_TYPE = {
  [TYPES.SINGLE]: 1,
  [TYPES.PAIR]: 2,
  [TYPES.TRIPLE]: 3,
  [TYPES.FULL_HOUSE]: 3
};

// Weights are hand tuned: structure (how many tricks the hand still needs)
// dominates, then bomb preservation, then card quality.
const W = {
  structTrick: 16,
  structBomb: 1.1,
  bombLead: 70,
  bombLeadEndgame: 12,
  wild: 9,
  control: 3,
  dump: 3,
  rankLead: 1.2,
  rankFollow: 1,
  topKind: 12,
  dumpEarly: 1.2,
  finishBias: 3
};

export function rankValue(rank, levelRank) {
  if (rank === 17) return 18;
  if (rank === 16) return 17;
  if (rank === levelRank) return 16;
  return rank;
}

function emptyPool() {
  const pool = Object.create(null);
  for (const rank of RANKS) pool[rank] = [];
  return pool;
}

export function handModel(hand, levelRank) {
  const pool = emptyPool();
  const wilds = [];
  for (const card of hand) {
    if (isHeartLevel(card, levelRank)) wilds.push(card);
    else pool[card.rank].push(card);
  }
  return { pool, wilds };
}

function powerOf(type, length) {
  if (type === TYPES.JOKER_BOMB) return 900;
  if (type === TYPES.FLUSH_STRAIGHT) return 55;
  if (type === TYPES.BOMB) return length * 10;
  return 0;
}

function makeGroup(type, cards, rank) {
  return { type, cards, rank, length: cards.length, power: powerOf(type, cards.length) };
}

function bombWeight(group) {
  if (group.type === TYPES.JOKER_BOMB) return 3;
  if (group.type === TYPES.FLUSH_STRAIGHT) return 1.4;
  if (group.type === TYPES.BOMB) {
    if (group.length >= 6) return 1.6;
    if (group.length === 5) return 1.3;
    return 1;
  }
  return 0;
}

function scorePlan(groups) {
  let weight = 0;
  let powerTotal = 0;
  for (const group of groups) {
    weight += bombWeight(group);
    powerTotal += group.power;
  }
  return { groups, tricks: groups.length, powerTotal, bombWeight: weight, score: groups.length - 0.8 * weight };
}

function buildPlan(hand, levelRank, flushFirst) {
  const { pool, wilds } = handModel(hand, levelRank);
  let wildPool = wilds.slice();
  const groups = [];

  const takeJokerBomb = () => {
    if (pool[16].length + pool[17].length !== 4) return;
    groups.push(makeGroup(TYPES.JOKER_BOMB, pool[16].concat(pool[17]), 17));
    pool[16] = [];
    pool[17] = [];
  };

  const takeBombs = () => {
    for (const rank of BOMB_RANKS) {
      if (pool[rank].length >= 4) groups.push(makeGroup(TYPES.BOMB, pool[rank].splice(0, pool[rank].length), rank));
    }
  };

  const takeWildBombs = () => {
    for (const rank of BOMB_RANKS) {
      if (!wildPool.length) return;
      if (pool[rank].length !== 3) continue;
      const cards = pool[rank].splice(0, 3).concat(wildPool.splice(0, 1));
      groups.push(makeGroup(TYPES.BOMB, cards, rank));
    }
  };

  const takeFlushStraights = () => {
    for (const suit of SUITS) {
      for (let start = 3; start <= SEQ_MAX - 4; start += 1) {
        const naturals = [];
        let gaps = 0;
        for (let rank = start; rank <= start + 4; rank += 1) {
          const card = pool[rank].find((item) => item.suit === suit);
          if (card) naturals.push(card);
          else gaps += 1;
        }
        if (naturals.length < 4 || gaps > wildPool.length) continue;
        const fill = gaps ? wildPool.splice(0, gaps) : [];
        for (const card of naturals) {
          const index = pool[card.rank].indexOf(card);
          if (index >= 0) pool[card.rank].splice(index, 1);
        }
        groups.push(makeGroup(TYPES.FLUSH_STRAIGHT, naturals.concat(fill), start + 4));
      }
    }
  };

  const takeRuns = (copies, minRun, maxRun, type) => {
    for (let run = maxRun; run >= minRun; run -= 1) {
      let start = 3;
      while (start + run - 1 <= SEQ_MAX) {
        const plan = [];
        let need = 0;
        for (let rank = start; rank <= start + run - 1; rank += 1) {
          const have = Math.min(copies, pool[rank].length);
          plan.push(pool[rank].slice(0, have));
          need += copies - have;
        }
        if (need > Math.min(1, wildPool.length)) {
          start += 1;
          continue;
        }
        const cards = [];
        for (let offset = 0; offset < run; offset += 1) {
          const rank = start + offset;
          pool[rank] = pool[rank].slice(plan[offset].length);
          cards.push(...plan[offset]);
        }
        if (need) cards.push(...wildPool.splice(0, need));
        groups.push(makeGroup(type, cards, start + run - 1));
        start += run;
      }
    }
  };

  const takeFullHouses = () => {
    for (const tripleRank of BOMB_RANKS) {
      while (pool[tripleRank].length >= 3) {
        const triple = pool[tripleRank].splice(0, 3);
        let pairRank = -1;
        for (const rank of BOMB_RANKS) {
          if (rank !== tripleRank && pool[rank].length >= 2) {
            pairRank = rank;
            break;
          }
        }
        if (pairRank < 0) {
          groups.push(makeGroup(TYPES.TRIPLE, triple, tripleRank));
          continue;
        }
        groups.push(makeGroup(TYPES.FULL_HOUSE, triple.concat(pool[pairRank].splice(0, 2)), tripleRank));
      }
    }
  };

  const takeLeftovers = () => {
    for (const rank of RANKS) {
      while (pool[rank].length >= 3 && rank <= 15) groups.push(makeGroup(TYPES.TRIPLE, pool[rank].splice(0, 3), rank));
      while (pool[rank].length >= 2) groups.push(makeGroup(TYPES.PAIR, pool[rank].splice(0, 2), rank));
      while (pool[rank].length >= 1) groups.push(makeGroup(TYPES.SINGLE, pool[rank].splice(0, 1), rank));
    }
    for (const card of wildPool) groups.push(makeGroup(TYPES.SINGLE, [card], levelRank));
    wildPool = [];
  };

  takeJokerBomb();
  if (flushFirst) {
    takeFlushStraights();
    takeBombs();
    takeWildBombs();
  } else {
    takeBombs();
    takeWildBombs();
    takeFlushStraights();
  }
  takeRuns(3, 2, 2, TYPES.TRIPLE_SEQ);
  takeRuns(2, 3, 3, TYPES.PAIR_SEQ);
  takeRuns(1, 5, 5, TYPES.STRAIGHT);
  takeFullHouses();
  takeLeftovers();
  return groups;
}

// Greedy decomposition of a hand into the fewest tricks, keeping bombs intact.
export function decompose(hand, levelRank) {
  const plain = scorePlan(buildPlan(hand, levelRank, false));
  const flush = scorePlan(buildPlan(hand, levelRank, true));
  return plain.score <= flush.score ? plain : flush;
}

function structureOfCards(hand, cards, base, levelRank) {
  const ids = new Set(cards.map((card) => card.id));
  const intact = base.groups.some(
    (group) => group.cards.length === cards.length && group.cards.every((card) => ids.has(card.id))
  );
  if (intact) return { tricks: 0, bombLoss: 0 };
  const rest = hand.filter((card) => !ids.has(card.id));
  const after = decompose(rest, levelRank);
  return {
    tricks: Math.max(0, after.tricks - (base.tricks - 1)),
    bombLoss: Math.max(0, base.powerTotal - after.powerTotal) / 15
  };
}

export function unseenCounts(match, seat) {
  const counts = emptyPool();
  for (const rank of RANKS) counts[rank] = rank >= 16 ? 2 : 8;
  for (const card of match.hands[seat] ?? []) counts[card.rank] -= 1;
  for (const card of match.playedCards ?? []) counts[card.rank] -= 1;
  for (const rank of RANKS) if (counts[rank] < 0) counts[rank] = 0;
  return counts;
}

export function isTopOfKind(combo, unseen, levelRank) {
  if (bombPower(combo)) return false;
  const need = COPIES_BY_TYPE[combo.type];
  if (!need) return false;
  const mine = rankValue(combo.rank, levelRank);
  for (const rank of RANKS) {
    if (rankValue(rank, levelRank) <= mine) continue;
    if ((unseen[rank] ?? 0) >= need) return false;
  }
  return true;
}

export function wildsUsed(cards, levelRank) {
  return cards.reduce((sum, card) => sum + (isHeartLevel(card, levelRank) ? 1 : 0), 0);
}

export function controlCost(cards, levelRank) {
  let total = 0;
  for (const card of cards) {
    const value = pointValue(card, levelRank);
    if (value >= 17) total += 3;
    else if (value === 16) total += 2;
    else if (value === 15) total += 1;
  }
  return total;
}

function dedupe(plays, levelRank) {
  const best = new Map();
  for (const combo of plays) {
    const key = [combo.type, combo.rank, combo.length, bombPower(combo)].join("|");
    const prev = best.get(key);
    if (!prev) {
      best.set(key, combo);
      continue;
    }
    const wildDelta = wildsUsed(combo.cards, levelRank) - wildsUsed(prev.cards, levelRank);
    if (wildDelta !== 0) {
      if (wildDelta < 0) best.set(key, combo);
      continue;
    }
    if (controlCost(combo.cards, levelRank) < controlCost(prev.cards, levelRank)) best.set(key, combo);
  }
  return [...best.values()].slice(0, MAX_CANDIDATES);
}

function buildContext(match, seat, levelRank) {
  const hand = match.hands[seat];
  const handsCount = match.hands.map((item) => item.length);
  const partner = (seat + 2) % 4;
  const alive = [0, 1, 2, 3].filter((index) => handsCount[index] > 0);
  const current = match.current ?? null;
  const winnerSeat = current ? match.lastPlay?.seat ?? match.leadSeat : null;
  const base = decompose(hand, levelRank);
  const candidates = dedupe(generatePlays(hand, levelRank, current), levelRank).map((combo) => ({
    c: combo,
    st: structureOfCards(hand, combo.cards, base, levelRank)
  }));
  const winnerCount = winnerSeat == null ? 0 : handsCount[winnerSeat];
  const partnerIsHead = match.finishOrder[0] === partner;
  const lastToAct = Boolean(current) && match.passes + 1 >= alive.length - 1;
  const stopNeeded = Boolean(current) && (winnerCount <= 6 || partnerIsHead || (lastToAct && winnerCount <= 10));
  return {
    match,
    seat,
    hand,
    levelRank,
    handsCount,
    partner,
    alive,
    current,
    winnerSeat,
    winnerCount,
    base,
    unseen: unseenCounts(match, seat),
    candidates,
    myCount: hand.length,
    partnerCount: handsCount[partner],
    lastToAct,
    stopNeeded,
    partnerIsHead
  };
}

function leadScore({ c, st }, ctx) {
  const { levelRank, base, myCount, unseen } = ctx;
  const power = bombPower(c);
  let score = 0;
  score -= W.structTrick * st.tricks;
  score -= W.structBomb * st.bombLoss;
  if (power) score -= base.tricks <= 2 || myCount <= 8 ? W.bombLeadEndgame : W.bombLead;
  score += W.dump * c.length;
  score -= W.rankLead * rankValue(c.rank, levelRank);
  score -= W.wild * wildsUsed(c.cards, levelRank);
  score -= W.control * controlCost(c.cards, levelRank);
  if (isTopOfKind(c, unseen, levelRank)) score += W.topKind;
  if (base.tricks <= 2 && !power) score += W.finishBias * rankValue(c.rank, levelRank);
  if (myCount >= 15) score += W.dumpEarly * c.length;
  return score;
}

function followScore({ c, st }, ctx) {
  const { levelRank, stopNeeded } = ctx;
  let score = 0;
  score -= W.structTrick * st.tricks;
  score -= W.structBomb * st.bombLoss;
  score -= W.wild * wildsUsed(c.cards, levelRank);
  score -= W.control * controlCost(c.cards, levelRank);
  score -= W.rankFollow * rankValue(c.rank, levelRank);
  score += W.dump * c.length;
  if (stopNeeded) score += 2 * c.length;
  return score;
}

function rankOrder(ctx) {
  const score = ctx.current ? followScore : leadScore;
  return ctx.candidates
    .map((item) => ({ item, score: score(item, ctx) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        rankValue(a.item.c.rank, ctx.levelRank) - rankValue(b.item.c.rank, ctx.levelRank) ||
        a.item.c.length - b.item.c.length
    );
}

function cardIds(combo) {
  return combo.cards.map((card) => card.id);
}

function lead(ctx, order) {
  if (!order.length) return { action: "play", cardIds: [ctx.hand[0].id], reason: "无牌可组", order };
  const { partnerCount, levelRank } = ctx;
  // Partner is about to go out: feed them exactly what they can play.
  if (partnerCount > 0 && partnerCount <= 2) {
    const fit = order
      .filter(({ item }) => !bombPower(item.c) && item.c.length === partnerCount)
      .sort((a, b) => rankValue(a.item.c.rank, levelRank) - rankValue(b.item.c.rank, levelRank));
    if (fit.length) return { action: "play", cardIds: cardIds(fit[0].item.c), reason: "送对家走", order };
  }
  const pick = order[0].item.c;
  return { action: "play", cardIds: cardIds(pick), reason: "领出" + comboLabel(pick), order };
}

function follow(ctx, order) {
  const { current, winnerSeat, partner, levelRank, lastToAct, stopNeeded, myCount } = ctx;
  if (winnerSeat === partner) return { action: "pass", reason: "队友的牌", order };

  const plain = order.filter(({ item }) => !bombPower(item.c));
  const bombs = order
    .filter(({ item }) => bombPower(item.c))
    .sort(
      (a, b) =>
        bombPower(a.item.c) - bombPower(b.item.c) ||
        a.item.st.bombLoss - b.item.st.bombLoss ||
        rankValue(a.item.c.rank, levelRank) - rankValue(b.item.c.rank, levelRank)
    );
  const trickSmall = !bombPower(current) && rankValue(current.rank, levelRank) <= 10;
  const trickFat = current.length >= 5 && rankValue(current.rank, levelRank) >= 10;

  if (plain.length) {
    const best = plain[0].item;
    const breaksBomb = best.st.bombLoss >= 1;
    const breaksShape = best.st.tricks >= 2;
    const spendsControl = controlCost(best.c.cards, levelRank) >= 2;
    const cheapWin = !breaksBomb && !breaksShape;
    if (cheapWin && !(spendsControl && trickSmall && !stopNeeded && !lastToAct)) {
      return { action: "play", cardIds: cardIds(best.c), reason: stopNeeded ? "拦住对手" : "压上家", order };
    }
    if (!lastToAct && !stopNeeded) return { action: "pass", reason: "先看队友", order };
    if (breaksBomb && !stopNeeded) return { action: "pass", reason: "不拆炸弹", order };
    if (!breaksShape || stopNeeded) return { action: "play", cardIds: cardIds(best.c), reason: "最后一家必须压", order };
    return { action: "pass", reason: "不拆牌", order };
  }

  if (bombs.length) {
    const allowed = stopNeeded || bombPower(current) > 0 || trickFat || myCount <= 8;
    if (allowed) return { action: "play", cardIds: cardIds(bombs[0].item.c), reason: "炸弹拦下", order };
    return { action: "pass", reason: "留着炸弹", order };
  }
  return { action: "pass", reason: "压不住", order };
}

function decide(ctx) {
  if (!ctx.hand.length) return { action: "pass", reason: "没有牌", order: [] };
  const order = rankOrder(ctx);
  const goingOut = order.find(({ item }) => item.c.length === ctx.myCount);
  if (goingOut) return { action: "play", cardIds: cardIds(goingOut.item.c), reason: "一把走完", order };
  return ctx.current ? follow(ctx, order) : lead(ctx, order);
}

export function chooseAction(match, seat, levelRank) {
  const ctx = buildContext(match, seat, levelRank);
  const decision = decide(ctx);
  if (!ctx.current && decision.action === "pass") {
    const fallback = rankOrder(ctx)[0] ?? ctx.candidates[0];
    if (fallback) {
      const combo = fallback.item?.c ?? fallback.c;
      return { action: "play", cardIds: cardIds(combo), reason: "必须出牌", order: decision.order };
    }
  }
  return decision;
}

export function suggestPlays(match, seat, levelRank) {
  const ctx = buildContext(match, seat, levelRank);
  const decision = decide(ctx);
  const list = [];
  const push = (action, ids, reason) => {
    if (!ids.length) return;
    const key = action + ":" + ids.slice().sort().join(",");
    if (!list.some((item) => item.key === key)) list.push({ key, action, cardIds: ids, reason });
  };
  push(decision.action, decision.cardIds ?? [], decision.reason);
  for (const { item } of decision.order ?? []) push("play", cardIds(item.c), comboLabel(item.c));
  if (ctx.current) list.push({ key: "pass", action: "pass", cardIds: [], reason: "不要" });
  return list.map(({ action, cardIds: ids, reason }) => ({ action, cardIds: ids, reason }));
}

export function chooseReturnCard(hand, allowed, levelRank) {
  if (!allowed.length) return null;
  const counts = Object.create(null);
  for (const card of hand) counts[card.rank] = (counts[card.rank] ?? 0) + 1;
  return allowed
    .slice()
    .sort((a, b) => {
      const lonely = (counts[a.rank] === 1 ? 0 : 8) - (counts[b.rank] === 1 ? 0 : 8);
      if (lonely !== 0) return lonely;
      return pointValue(a, levelRank) - pointValue(b, levelRank);
    })[0];
}
