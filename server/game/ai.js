import { isHeartLevel, pointValue, rankAtPosition, rankValue } from "./cards.js";
import { TYPES, bombPower, canBeat, comboKey, comboLabel, parseCombos } from "./combos.js";
import { createPlanner, controlEstimate, unknownWilds } from "./ai-planner.js";
import { generatePlays } from "./moves.js";

export const DIFFICULTIES = ["easy", "medium", "hard"];

const RANKS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
const BOMB_RANKS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const SEQ_MAX = 14;
const SUITS = ["S", "H", "D", "C"];

// Runs live on the position axis: 1=A(low), 2=the two, 3..14=3..A. The ace
// owns both position 14 and position 1, so try the ordinary starts first and
// leave ace-low for last instead of breaking 10JQKA up to build A2345.
function runStarts(runLen) {
  const last = SEQ_MAX - runLen + 1;
  const starts = [];
  for (let start = 2; start <= last; start += 1) starts.push(start);
  if (last >= 1) starts.push(1);
  return starts;
}
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

// easy = former medium; medium = former hard. Hard adds bounded whole-hand
// planning and public-information endgame tactics; it never reads other hands.
const PROFILE = {
  easy: {
    planner: "structure",
    noise: 3.4,
    partnerAware: false,
    stopAware: false,
    feedPartner: false,
    topKind: false,
    bombLead: 34
  },
  medium: {
    planner: "structure",
    noise: 0,
    partnerAware: true,
    stopAware: true,
    feedPartner: true,
    topKind: true,
    bombLead: W.bombLead
  },
  hard: { planner: "search", noise: 0, partnerAware: true, stopAware: true,
    feedPartner: true, topKind: true, bombLead: W.bombLead }
};

export function normalizeDifficulty(value) {
  return DIFFICULTIES.includes(value) ? value : "hard";
}

function profileOf(difficulty) {
  return PROFILE[normalizeDifficulty(difficulty)];
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
      for (const start of runStarts(5)) {
        const naturals = [];
        let gaps = 0;
        for (let offset = 0; offset < 5; offset += 1) {
          const rank = rankAtPosition(start + offset);
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
      for (const start of runStarts(run)) {
        const plan = [];
        let need = 0;
        for (let offset = 0; offset < run; offset += 1) {
          const rank = rankAtPosition(start + offset);
          const have = Math.min(copies, pool[rank].length);
          plan.push(pool[rank].slice(0, have));
          need += copies - have;
        }
        if (need > Math.min(1, wildPool.length)) continue;
        const cards = [];
        for (let offset = 0; offset < run; offset += 1) {
          const rank = rankAtPosition(start + offset);
          pool[rank] = pool[rank].slice(plan[offset].length);
          cards.push(...plan[offset]);
        }
        if (need) cards.push(...wildPool.splice(0, need));
        groups.push(makeGroup(type, cards, start + run - 1));
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

// 五张同花色连牌既能当同花顺（炸弹）也能当普通顺子出。按“这手牌本身能当
// 炸弹”计价，机器人才不会把同花顺拆成顺子白送出去。
function effectiveBombPower(combo, levelRank) {
  const own = bombPower(combo);
  if (own || combo.cards.length < 4) return own;
  let best = 0;
  for (const item of parseCombos(combo.cards, levelRank)) best = Math.max(best, bombPower(item));
  return best;
}

function buildContext(match, seat, levelRank, profile) {
  const hand = match.hands[seat];
  const handsCount = match.hands.map((item) => item.length);
  const partner = (seat + 2) % 4;
  const alive = [0, 1, 2, 3].filter((index) => handsCount[index] > 0);
  const current = match.current ?? null;
  const winnerSeat = current ? match.lastPlay?.seat ?? match.leadSeat : null;
  const planner = profile.planner === "search" ? createPlanner(hand, levelRank, decompose) : null;
  const base = planner ? planner.plan() : decompose(hand, levelRank);
  const candidates = (planner ? planner.candidates.filter((c) => canBeat(c, current))
    : dedupe(generatePlays(hand, levelRank, current), levelRank)).map((combo) => ({
    c: combo,
    bp: effectiveBombPower(combo, levelRank),
    st: planner ? null : structureOfCards(hand, combo.cards, base, levelRank)
  }));
  const winnerCount = winnerSeat == null ? 0 : handsCount[winnerSeat];
  const partnerIsHead = match.finishOrder[0] === partner;
  const requiredPasses = profile.planner === "search" ? alive.filter((index) => index !== winnerSeat).length : alive.length;
  const lastToAct = Boolean(current) && match.passes + 1 >= requiredPasses;
  const stopNeeded =
    Boolean(current) &&
    profile.stopAware &&
    (winnerCount <= 6 || partnerIsHead || (lastToAct && winnerCount <= 10));
  return {
    match,
    seat,
    hand,
    levelRank,
    profile,
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
    partnerIsHead,
    planner
  };
}

function leadScore({ c, st, bp }, ctx) {
  const { levelRank, base, myCount, unseen, profile } = ctx;
  const power = bp ?? bombPower(c);
  let score = 0;
  score -= W.structTrick * st.tricks;
  score -= W.structBomb * st.bombLoss;
  if (power) score -= base.tricks <= 2 || myCount <= 8 ? W.bombLeadEndgame : profile.bombLead;
  score += W.dump * c.length;
  score -= W.rankLead * rankValue(c.rank, levelRank);
  score -= W.wild * wildsUsed(c.cards, levelRank);
  score -= W.control * controlCost(c.cards, levelRank);
  if (profile.topKind && isTopOfKind(c, unseen, levelRank)) score += W.topKind;
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

function rankOrder(ctx, rng = Math.random) {
  const score = ctx.current ? followScore : leadScore;
  const noise = ctx.profile.noise || 0;
  return ctx.candidates
    .map((item) => ({ item, score: score(item, ctx) + (noise ? (rng() * 2 - 1) * noise : 0) }))
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

// The engine replays the exact reading the planner scored instead of guessing one
// of its own, so the shape on the table always matches the shape the AI valued.
function playDecision(combo, reason, order) {
  return { action: "play", cardIds: cardIds(combo), comboKey: comboKey(combo), reason, order };
}

function lead(ctx, order) {
  if (!order.length) return { action: "play", cardIds: [ctx.hand[0].id], reason: "无牌可组", order };
  const { partnerCount, levelRank, profile } = ctx;
  // Partner is about to go out: feed them exactly what they can play.
  if (profile.feedPartner && partnerCount > 0 && partnerCount <= 2) {
    const fit = order
      .filter(({ item }) => !item.bp && item.c.length === partnerCount)
      .sort((a, b) => rankValue(a.item.c.rank, levelRank) - rankValue(b.item.c.rank, levelRank));
    if (fit.length) return playDecision(fit[0].item.c, "送对家走", order);
  }
  const pick = order[0].item.c;
  return playDecision(pick, "领出" + comboLabel(pick), order);
}

function follow(ctx, order) {
  const { current, winnerSeat, partner, levelRank, lastToAct, stopNeeded, myCount, profile } = ctx;
  if (profile.partnerAware && winnerSeat === partner) return { action: "pass", reason: "队友的牌", order };

  const plain = order.filter(({ item }) => !item.bp);
  const bombs = order
    .filter(({ item }) => item.bp)
    .sort(
      (a, b) =>
        a.item.bp - b.item.bp ||
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
      return playDecision(best.c, stopNeeded ? "拦住对手" : "压上家", order);
    }
    if (!lastToAct && !stopNeeded) return { action: "pass", reason: "先看队友", order };
    if (breaksBomb && !stopNeeded) return { action: "pass", reason: "不拆炸弹", order };
    if (!breaksShape || stopNeeded) return playDecision(best.c, "最后一家必须压", order);
    return { action: "pass", reason: "不拆牌", order };
  }

  if (bombs.length) {
    const allowed = stopNeeded || bombPower(current) > 0 || trickFat || myCount <= 8;
    if (allowed) return playDecision(bombs[0].item.c, "炸弹拦下", order);
    return { action: "pass", reason: "留着炸弹", order };
  }
  return { action: "pass", reason: "压不住", order };
}

function hardOrder(ctx) {
  const { hand, levelRank, planner, base, current, unseen } = ctx;
  const opponents = [1, 3].map((offset) => ctx.handsCount[(ctx.seat + offset) % 4]).filter(Boolean);
  const enemyMin = opponents.length ? Math.min(...opponents) : Infinity;
  const wilds = unknownWilds(ctx.match, ctx.seat, levelRank);
  const baseBombs = base.groups.filter((g) => bombPower(g));
  const controlCache = new Map();
  const estimate = (group) => {
    const key = [group.type, group.rank, group.length].join(":");
    if (!controlCache.has(key)) controlCache.set(key, controlEstimate(group, unseen, opponents, levelRank, wilds));
    return controlCache.get(key);
  };
  // A hand of weak leftovers needs entries (controls) to regain the lead.
  // Spending the final entry repeatedly is not progress just because it stops
  // a short opponent. Count this debt as well as the number of remaining plays.
  const entryDebt = (plan) => Math.max(0, plan.groups.reduce((sum, group) => {
    const strength = estimate(group);
    return sum + (strength >= 0.75 ? -1 : 1 - strength);
  }, 0) - 1);
  const beforeDebt = entryDebt(base);
  return ctx.candidates.map((item) => {
    const { c, bp } = item;
    const after = planner.after(c.cards);
    const ids = new Set(cardIds(c));
    const brokenBombs = baseBombs.filter((g) => g.cards.some((card) => ids.has(card.id)) &&
      !g.cards.every((card) => ids.has(card.id))).length;
    const control = estimate(c);
    const debt = entryDebt(after);
    const debtIncrease = Math.max(0, debt - beforeDebt);
    const extra = Math.max(0, after.tricks + 1 - base.tricks);
    // Total remaining cover matters more than immediate card count. A bomb is
    // a resource, not sacred: spend it to recover tempo for a short finish.
    let score = -28 * after.score + 2 * c.length - 0.85 * rankValue(c.rank, levelRank);
    score -= 16 * brokenBombs + 3 * wildsUsed(c.cards, levelRank);
    score -= 1.5 * controlCost(c.cards, levelRank);
    score -= 10 * debt + 16 * debtIncrease;
    if (bp) score -= after.tricks <= 1 ? 8 : 40;
    if (after.tricks <= 1) score += 55 * control;
    if (enemyMin <= 2) {
      score += (current ? 32 : 12) * control;
      if (!current && c.type === TYPES.SINGLE && enemyMin === 1) score -= 45 * (1 - control);
      if (!current && c.type === TYPES.PAIR && enemyMin === 2) score -= 18 * (1 - control);
    }
    // Prefer a cheap feed, but do not dismantle a bomb or feed the enemy's
    // last card. Two remaining partner cards are not necessarily a pair.
    if (!current && ctx.partnerCount > 0 && ctx.partnerCount <= 2 && enemyMin > 2 &&
        !bp && !brokenBombs && extra === 0 && c.length === ctx.partnerCount) {
      score += 22 - rankValue(c.rank, levelRank);
    }
    return { item: { ...item, after, control, debtIncrease, brokenBombs, st: { tricks: extra, bombLoss: brokenBombs } }, score };
  }).sort((a, b) => b.score - a.score || a.item.bp - b.item.bp ||
    rankValue(a.item.c.rank, levelRank) - rankValue(b.item.c.rank, levelRank));
}

function hardDecide(ctx) {
  const order = hardOrder(ctx);
  const pass = (reason) => ({ action: "pass", reason, order });
  const play = (entry, reason) => playDecision(entry.item.c, reason, order);
  if (!order.length) return pass("压不住");
  const finish = order.find(({ item }) => item.c.length === ctx.myCount);
  if (finish) return play(finish, "一把走完");
  const best = order[0];
  if (!ctx.current) return play(best, best.item.after.tricks === 1 && best.item.control >= 0.8
    ? "先控牌，再争取走完" : "按整手配牌领出");

  if (ctx.winnerSeat === ctx.partner) {
    // A partner already out will pass the lead back to us (接风). Do not burn
    // controls to win a trick our team already owns. Otherwise overtake only
    // with a very strong two-trick exit, or to guard an enemy's last single.
    if (!ctx.partnerCount) return pass("让队友接风");
    const exit = order.find(({ item }) => item.after.tricks === 1 && item.control >= 0.98 && !item.brokenBombs);
    if (exit && ctx.partnerCount > 2) return play(exit, "接手控牌，争取自己先走");
    const enemySingle = [1, 3].some((offset) => ctx.handsCount[(ctx.seat + offset) % 4] === 1);
    const enemies = [1, 3].map((offset) => ctx.handsCount[(ctx.seat + offset) % 4]);
    const partnerControl = controlEstimate(ctx.current, ctx.unseen, enemies, ctx.levelRank,
      unknownWilds(ctx.match, ctx.seat, ctx.levelRank));
    const guard = order.find(({ item }) => !item.bp && !item.brokenBombs && item.control > partnerControl + 0.4);
    if (enemySingle && ctx.current.type === TYPES.SINGLE && guard &&
        (guard.item.after.tricks <= 1 || guard.item.debtIncrease < 0.6))
      return play(guard, "保护队友，封住单张");
    return pass("让队友走牌");
  }

  const enemyHead = ctx.match.finishOrder.length > 0 && ctx.match.finishOrder[0] % 2 !== ctx.seat % 2;
  // Someone who has already finished cannot be stopped. Overtaking that last
  // trick may deny their partner a lead, but is not automatically an emergency.
  const urgent = ctx.winnerCount > 0 && (ctx.winnerCount <= 2 || (enemyHead && ctx.winnerCount <= 6));
  const terminalRisk = enemyHead && ctx.winnerCount > 0 && ctx.winnerCount <= 2;
  const exhaustedEntry = ({ item }) => item.after.tricks > 1 && item.debtIncrease >= 0.6;
  const plains = order.filter(({ item }) => !item.bp);
  if (plains.length) {
    const cheap = plains.find(({ item }) => !item.brokenBombs && item.st.tricks <= 1);
    if (urgent) {
      // Blocking is a means, not the objective: retain structure and future
      // entries. Only impending enemy double-finish justifies desperate breaks.
      const safe = plains.filter(({ item }) => !item.brokenBombs && item.st.tricks <= 1);
      const pool = terminalRisk ? plains : safe;
      const controlWeight = terminalRisk ? 120 : 18;
      const block = pool.slice().sort((a, b) =>
        (b.score + controlWeight * b.item.control) - (a.score + controlWeight * a.item.control))[0];
      if (block && (terminalRisk || !exhaustedEntry(block)))
        return play(block, "兼顾余牌结构，拦截对手");
      if (block && !ctx.lastToAct) return pass("不耗尽控制牌，交给队友接应");
    }
    if (cheap) {
      const expensive = controlCost(cheap.item.c.cards, ctx.levelRank) >= 2;
      if (!terminalRisk && exhaustedEntry(cheap)) return pass("保留回手大牌，避免只剩小牌");
      if (expensive && cheap.item.after.tricks > 1 && !urgent && !ctx.lastToAct && rankValue(ctx.current.rank, ctx.levelRank) <= 10)
        return pass("保留大牌，先看队友");
      return play(cheap, "顺手出牌，保留配牌结构");
    }
  }
  const bombs = order.filter(({ item }) => item.bp && !item.brokenBombs);
  if (bombs.length) {
    const finishSetup = bombs.find(({ item }) => item.after.tricks <= 1);
    const shortOpponent = ctx.winnerCount > 0 && ctx.winnerCount <= 6;
    const worthwhile = urgent || (shortOpponent && ctx.base.tricks <= 3) || bombPower(ctx.current) ||
      (ctx.current.length >= 5 && rankValue(ctx.current.rank, ctx.levelRank) >= 10);
    if (finishSetup && ctx.myCount <= 8) return play(finishSetup, "用炸弹争先，准备收尾");
    if (worthwhile) {
      const usable = bombs.filter((entry) => terminalRisk || !exhaustedEntry(entry));
      usable.sort((a, b) => a.item.bp - b.item.bp || b.score - a.score);
      if (usable.length) return play(usable[0], "用足够的炸弹拦截，保留回手能力");
    }
  }
  return pass("不拆牌，留住控制牌");
}

function decide(ctx, rng = Math.random) {
  if (!ctx.hand.length) return { action: "pass", reason: "没有牌", order: [] };
  if (ctx.planner) return hardDecide(ctx);
  const order = rankOrder(ctx, rng);
  const goingOut = order.find(({ item }) => item.c.length === ctx.myCount);
  if (goingOut) return playDecision(goingOut.item.c, "一把走完", order);
  return ctx.current ? follow(ctx, order) : lead(ctx, order);
}

export function chooseAction(match, seat, levelRank, difficulty = "hard", rng = Math.random) {
  const ctx = buildContext(match, seat, levelRank, profileOf(difficulty));
  const decision = decide(ctx, rng);
  if (!ctx.current && decision.action === "pass") {
    const fallback = rankOrder(ctx, rng)[0] ?? ctx.candidates[0];
    if (fallback) {
      const combo = fallback.item?.c ?? fallback.c;
      return playDecision(combo, "必须出牌", decision.order);
    }
  }
  return decision;
}

export function suggestPlays(match, seat, levelRank) {
  // Hints always use the strongest read, whatever level the table's bots are.
  const ctx = buildContext(match, seat, levelRank, PROFILE.hard);
  const decision = decide(ctx, () => 0.5);
  const list = [];
  const push = (action, ids, reason, combo = null) => {
    if (!ids.length) return;
    const dedupe = (combo ? combo + "|" : "") + action + ":" + ids.slice().sort().join(",");
    if (list.some((item) => item.key === dedupe)) return;
    list.push({ key: dedupe, action, cardIds: ids, reason, comboKey: combo });
  };
  push(decision.action, decision.cardIds ?? [], decision.reason, decision.comboKey ?? null);
  for (const { item } of decision.order ?? []) push("play", cardIds(item.c), comboLabel(item.c), comboKey(item.c));
  if (ctx.current) list.push({ key: "pass", action: "pass", cardIds: [], reason: "不要", comboKey: null });
  return list.map(({ action, cardIds: ids, reason, comboKey: combo }) => ({ action, cardIds: ids, reason, comboKey: combo ?? null }));
}

export function chooseReturnCard(hand, allowed, levelRank, difficulty = "hard", rng = Math.random) {
  if (!allowed.length) return null;
  if (normalizeDifficulty(difficulty) === "hard") {
    const planner = createPlanner(hand, levelRank, decompose);
    planner.plan();
    return allowed.map((card) => ({ card, score: planner.after([card]).score }))
      .sort((a, b) => a.score - b.score || pointValue(a.card, levelRank) - pointValue(b.card, levelRank))[0].card;
  }
  // Both lower tiers retain the former medium/hard return-card policy.
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
