import {
  bumpLevel,
  cardLabel,
  compareCards,
  createShoe,
  isHeartLevel,
  levelLabel,
  pointValue,
  shuffle,
  sortHand
} from "./cards.js";
import { bombPower, canBeat, comboKey, comboLabel, comboOption, parseCombo, parseCombos } from "./combos.js";
import { generatePlays } from "./moves.js";
import { chooseAction, chooseReturnCard, normalizeDifficulty } from "./ai.js";

const TEAM_NAMES = ["红队", "蓝队"];

function teamOf(seat) {
  return seat % 2;
}

function partnerOf(seat) {
  return (seat + 2) % 4;
}

function emptyHands(hands) {
  return [0, 1, 2, 3].filter((seat) => hands[seat].length === 0);
}

function cloneCards(cards) {
  return cards.map((card) => ({ ...card }));
}

export function createMatch(names, options = {}) {
  return {
    names: names.slice(0, 4),
    bots: options.bots ?? [false, false, false, false],
    difficulty: normalizeDifficulty(options.difficulty),
    teamLevel: [15, 15],
    bankerTeam: 0,
    round: 0,
    winnerTeam: null,
    log: [],
    phase: "deal",
    hands: [[], [], [], []],
    lastHands: [[], [], [], []],
    finishOrder: [],
    playedCards: [],
    current: null,
    leadSeat: 0,
    turn: 0,
    passes: 0,
    lastPlay: null,
    lastPlays: [null, null, null, null],
    tributePlan: [],
    returnsPlan: [],
    tributeRefused: [],
    tributeSummary: [],
    roundResult: null,
    nextLead: 0,
    history: []
  };
}

export function levelRankOf(match) {
  return match.teamLevel[match.bankerTeam];
}

function addLog(match, text) {
  match.log.push(text);
  if (match.log.length > 40) match.log.shift();
}

function deal(match, rng) {
  const shoe = shuffle(createShoe(), rng);
  match.hands = [[], [], [], []];
  for (let i = 0; i < shoe.length; i += 1) {
    match.hands[i % 4].push(shoe[i]);
  }
  const levelRank = levelRankOf(match);
  match.hands = match.hands.map((hand) => sortHand(hand, levelRank));
}

function firstHeartThree(match) {
  for (let seat = 0; seat < 4; seat += 1) {
    if (match.hands[seat].some((card) => card.suit === "H" && card.rank === 3)) return seat;
  }
  return 0;
}

function highestCard(hand, levelRank) {
  return hand.slice().sort((a, b) => compareCards(a, b, levelRank)).at(-1);
}

function bigJokerCount(hand) {
  return hand.filter((card) => card.rank === 17).length;
}

// 逢人配（红桃级牌）不作为贡牌，改取次大的牌
function tributeCard(hand, levelRank) {
  const pool = hand.filter((card) => !isHeartLevel(card, levelRank));
  return highestCard(pool.length ? pool : hand, levelRank);
}

function takeCard(hand, cardId) {
  const index = hand.findIndex((card) => card.id === cardId);
  if (index < 0) return null;
  return hand.splice(index, 1)[0];
}

function giveCard(match, from, to, card) {
  match.hands[to].push(card);
  const levelRank = levelRankOf(match);
  match.hands[from] = sortHand(match.hands[from], levelRank);
  match.hands[to] = sortHand(match.hands[to], levelRank);
}

function upgradeFor(finishOrder) {
  const first = finishOrder[0];
  const second = finishOrder[1];
  const third = finishOrder[2];
  if (teamOf(first) === teamOf(second)) return { steps: 3, kind: "双下" };
  if (teamOf(first) === teamOf(third)) return { steps: 2, kind: "头三" };
  return { steps: 1, kind: "头末" };
}

function canPassAce(kind) {
  return kind === "双下" || kind === "头三";
}

function beginPlay(match, leadSeat, reason) {
  match.phase = "play";
  match.current = null;
  match.lastPlay = null;
  match.lastPlays = [null, null, null, null];
  match.passes = 0;
  match.leadSeat = leadSeat;
  match.turn = leadSeat;
  addLog(match, reason);
}

export function buildTribute(match) {
  const finish = match.finishOrder;
  const kind = upgradeFor(finish).kind;
  const levelRank = levelRankOf(match);
  match.tributePlan = [];
  match.returnsPlan = [];
  match.tributeRefused = [];

  const head = finish[0];
  // 名次决定进贡方：双下由末游和三游各进一贡，其余只有末游进贡。末游若正好
  // 是头游的队友，就是“内供”，照样要进。
  const payers = kind === "双下" ? [finish[3], finish[2]] : [finish[3]];
  const receivers = kind === "双下" ? [head, finish[1]] : [head];

  // 抗贡：进贡方合计握有两张大王（双下时允许一人一张）
  const jokers = payers.reduce((sum, seat) => sum + bigJokerCount(match.hands[seat]), 0);
  if (jokers >= 2) {
    match.tributeRefused = payers.slice();
    const refusedNames = payers.map((seat) => match.names[seat]).join("、");
    addLog(match, `${refusedNames} 双大王抗贡`);
    match.tributeSummary = [`${refusedNames} 手握双大王，抗贡成功，本局不进贡`];
    // 抗贡没人进贡，按规则回到头游先出
    match.nextLead = head;
    return false;
  }

  const gifts = payers
    .map((seat) => ({ from: seat, card: tributeCard(match.hands[seat], levelRank) }))
    .filter((gift) => gift.card)
    .sort((a, b) => compareCards(a.card, b.card, levelRank));
  if (!gifts.length) return false;

  // 大贡给头游，小贡给二游
  const big = gifts.at(-1);
  match.tributePlan.push({ from: big.from, to: receivers[0], cardId: big.card.id });
  if (gifts.length > 1 && receivers.length > 1) {
    match.tributePlan.push({ from: gifts[0].from, to: receivers[1], cardId: gifts[0].card.id });
  }
  // 还贡之后由进贡方先出：单下是末游，双下是进贡大牌的那一家
  match.nextLead = big.from;
  return true;
}

function applyTribute(match) {
  for (const step of match.tributePlan) {
    const card = takeCard(match.hands[step.from], step.cardId);
    if (!card) continue;
    giveCard(match, step.from, step.to, card);
    const text = `${match.names[step.from]} 进贡 ${cardLabel(card)} 给 ${match.names[step.to]}`;
    addLog(match, text);
    match.tributeSummary.push(text);
    match.returnsPlan.push({ from: step.to, to: step.from });
  }
}

export function returnableCards(hand, levelRank) {
  const modest = hand.filter((card) => card.rank >= 3 && card.rank <= 10 && !isHeartLevel(card, levelRank));
  if (modest.length) return modest;
  return hand.slice().sort((a, b) => compareCards(a, b, levelRank));
}

export function startRound(match, rng = Math.random) {
  const previousFinish = match.roundResult?.finishOrder ?? match.finishOrder.slice();
  match.round += 1;
  match.phase = "deal";
  match.finishOrder = [];
  match.roundResult = null;
  match.tributePlan = [];
  match.returnsPlan = [];
  match.tributeRefused = [];
  match.tributeSummary = [];
  match.playedCards = [];
  match.current = null;
  match.lastPlay = null;
  match.lastPlays = [null, null, null, null];
  deal(match, rng);
  match.lastHands = match.hands.map(cloneCards);
  const levelRank = levelRankOf(match);
  addLog(
    match,
    `第${match.round}局，${TEAM_NAMES[match.bankerTeam]}打${levelLabel(levelRank)}，逢人配是红桃${levelLabel(levelRank)}`
  );

  if (match.round === 1) {
    const lead = firstHeartThree(match);
    match.nextLead = lead;
    beginPlay(match, lead, `${match.names[lead]} 有红桃3，先出`);
    return match;
  }

  match.finishOrder = previousFinish.slice();
  match.nextLead = previousFinish[0] ?? firstHeartThree(match);
  if (previousFinish.length === 4 && buildTribute(match)) {
    applyTribute(match);
    match.phase = "returnTribute";
    match.turn = match.returnsPlan[0]?.from ?? match.nextLead;
    addLog(match, "进贡完成，等待还贡");
    match.finishOrder = [];
    return match;
  }

  const lead = match.nextLead;
  match.finishOrder = [];
  beginPlay(match, lead, `${match.names[lead]} 先出`);
  return match;
}

export function returnTribute(match, seat, cardId) {
  if (match.phase !== "returnTribute") return { ok: false, error: "现在不是还贡阶段" };
  const step = match.returnsPlan.find((item) => item.from === seat);
  if (!step) return { ok: false, error: "还没轮到你还贡" };
  const allowed = returnableCards(match.hands[seat], levelRankOf(match));
  const card = allowed.find((item) => item.id === cardId) ?? allowed[0];
  if (!card) return { ok: false, error: "没有可还的牌" };
  const taken = takeCard(match.hands[seat], card.id);
  giveCard(match, seat, step.to, taken);
  const text = `${match.names[seat]} 还贡 ${cardLabel(taken)} 给 ${match.names[step.to]}`;
  addLog(match, text);
  match.tributeSummary.push(text);
  match.returnsPlan = match.returnsPlan.filter((item) => item.from !== seat);
  if (!match.returnsPlan.length) {
    beginPlay(match, match.nextLead, `${match.names[match.nextLead]} 进贡方先出`);
  } else {
    match.turn = match.returnsPlan[0].from;
  }
  return { ok: true };
}

function nextSeatWithCards(match, from) {
  for (let step = 1; step <= 4; step += 1) {
    const seat = (from + step) % 4;
    if (match.hands[seat].length > 0) return seat;
  }
  return from;
}

function finishSeat(match, seat) {
  if (match.finishOrder.includes(seat)) return;
  match.finishOrder.push(seat);
  const titles = ["头游", "二游", "三游", "末游"];
  addLog(match, `${match.names[seat]} ${titles[match.finishOrder.length - 1]}`);
  // 双下不必打完：同队包揽头游二游时名次已定，剩下两家按手牌多少排三游末游
  if (match.finishOrder.length === 2 && teamOf(match.finishOrder[0]) === teamOf(match.finishOrder[1])) {
    const rest = [0, 1, 2, 3]
      .filter((item) => !match.finishOrder.includes(item))
      .sort((a, b) => match.hands[a].length - match.hands[b].length || a - b);
    match.finishOrder.push(...rest);
    addLog(match, `${match.names[rest[0]]} 三游`);
    addLog(match, `${match.names[rest[1]]} 末游`);
    addLog(match, "双下，本局提前结束");
    endRound(match);
    return;
  }
  if (match.finishOrder.length === 3) {
    const last = [0, 1, 2, 3].find((item) => !match.finishOrder.includes(item));
    match.finishOrder.push(last);
    addLog(match, `${match.names[last]} 末游`);
    endRound(match);
  }
}

function endRound(match) {
  const result = upgradeFor(match.finishOrder);
  const winTeam = teamOf(match.finishOrder[0]);
  const loseTeam = 1 - winTeam;
  const before = match.teamLevel[winTeam];
  let nextLevel = bumpLevel(before, result.steps);
  let matchOver = false;
  if (before === 14) {
    if (canPassAce(result.kind)) {
      matchOver = true;
      nextLevel = 14;
    } else {
      nextLevel = 14;
      addLog(match, `${TEAM_NAMES[winTeam]} 打A未过，继续打A`);
    }
  }
  match.teamLevel[winTeam] = nextLevel;
  match.bankerTeam = winTeam;
  // The level card changed hands: re-sort every leftover hand with the new level
  // so the round-over screen keeps the same order the next deal will use.
  const levelRank = levelRankOf(match);
  match.hands = match.hands.map((hand) => sortHand(hand, levelRank));
  match.roundResult = {
    kind: result.kind,
    winTeam,
    loseTeam,
    steps: result.steps,
    finishOrder: match.finishOrder.slice(),
    matchOver
  };
  match.history.push(match.roundResult);
  addLog(
    match,
    `${TEAM_NAMES[winTeam]} ${result.kind}，${TEAM_NAMES[winTeam]} ${levelLabel(before)} -> ${levelLabel(nextLevel)}`
  );
  if (matchOver) {
    match.phase = "matchOver";
    match.winnerTeam = winTeam;
    addLog(match, `${TEAM_NAMES[winTeam]} 过A，胜出`);
  } else {
    match.phase = "roundOver";
  }
}

function defaultComboOrder(a, b) {
  if (a.bombPower !== b.bombPower) return b.bombPower - a.bombPower;
  if (a.type !== b.type) return a.type.localeCompare(b.type);
  return (a.value ?? a.rank) - (b.value ?? b.rank);
}

function weakestWinningOrder(a, b) {
  return (
    bombPower(a) - bombPower(b) ||
    (a.value ?? a.rank) - (b.value ?? b.rank) ||
    a.length - b.length ||
    a.type.localeCompare(b.type)
  );
}

function defaultReading(readings, current) {
  const ordered = readings.slice().sort(defaultComboOrder);
  if (!current) return ordered[0] ?? null;
  const preferredType = !bombPower(current) ? current.type : null;
  const preferred = preferredType ? ordered.find((item) => item.type === preferredType) : null;
  if (preferred && canBeat(preferred, current)) return preferred;
  return readings.filter((item) => canBeat(item, current)).sort(weakestWinningOrder)[0] ?? preferred ?? null;
}

export function playCards(match, seat, cardIds, reason = "", preferredKey = null, allowAmbiguous = true) {
  if (match.phase !== "play") return { ok: false, error: "还没轮到出牌" };
  if (match.turn !== seat) return { ok: false, error: "没轮到你" };
  const hand = match.hands[seat];
  if (new Set(cardIds).size !== cardIds.length) return { ok: false, error: "\u91cd\u590d\u7684\u724c" };
  const cards = cardIds.map((id) => hand.find((card) => card.id === id)).filter(Boolean);
  if (cards.length !== cardIds.length) return { ok: false, error: "手里没有这些牌" };
  const levelRank = levelRankOf(match);
  const readings = parseCombos(cards, levelRank);
  let combo = null;

  if (preferredKey) {
    combo = readings.find((item) => comboKey(item) === preferredKey) ?? null;
    if (!combo) return { ok: false, error: "选择的牌型组合无效" };
  } else {
    const playable = match.current ? readings.filter((item) => canBeat(item, match.current)) : readings;
    if (!playable.length) {
      return { ok: false, error: readings.length ? "压不住上家" : "这不是合法牌型" };
    }
    if (
      allowAmbiguous &&
      playable.length > 1 &&
      // The live seat controller decides; a cached bots array goes stale
      // when a player refreshes back into a seat the server gave to a bot.
      !match.bots?.[seat]
    ) {
      return {
        ok: false,
        ambiguous: true,
        options: playable
          .slice()
          .sort(weakestWinningOrder)
          .map((item) => comboOption(item))
      };
    }
    combo = defaultReading(readings, match.current);
  }

  if (!combo) return { ok: false, error: "这不是合法牌型" };
  if (match.current && !canBeat(combo, match.current)) return { ok: false, error: "压不住上家" };
  if (!match.current && combo.cards.length === 0) return { ok: false, error: "必须出牌" };

  for (const id of cardIds) takeCard(hand, id);
  if (!Array.isArray(match.playedCards)) match.playedCards = [];
  for (const card of combo.cards) match.playedCards.push({ ...card });
  match.hands[seat] = sortHand(hand, levelRankOf(match));
  match.current = combo;
  match.lastPlay = { seat, combo };
  match.lastPlays[seat] = combo;
  match.passes = 0;
  match.leadSeat = seat;
  const why = reason ? `（${reason}）` : "";
  addLog(match, `${match.names[seat]} 出 ${comboLabel(combo)} ${combo.cards.map(cardLabel).join(" ")}${why}`);

  if (match.hands[seat].length === 0) {
    finishSeat(match, seat);
    if (match.phase !== "play") return { ok: true };
  }
  match.turn = nextSeatWithCards(match, seat);
  return { ok: true };
}

export function passTurn(match, seat, reason = "") {
  if (match.phase !== "play") return { ok: false, error: "还没轮到出牌" };
  if (match.turn !== seat) return { ok: false, error: "没轮到你" };
  if (!match.current) return { ok: false, error: "首出不能过" };
  match.lastPlays[seat] = { type: "pass", label: "过", cards: [] };
  addLog(match, reason ? `${match.names[seat]} 不要（${reason}）` : `${match.names[seat]} 不要`);
  match.turn = nextSeatWithCards(match, seat);
  match.passes += 1;

  const remaining = [0, 1, 2, 3].filter((item) => match.hands[item].length > 0);
  // A trick ends only after every player who still holds cards has passed.
  // The old "remaining - 1" check cut the trick short once a player had gone
  // out, so the last seat never got its chance to beat the play.
  if (match.passes >= remaining.length && match.phase === "play") {
    const winner = match.leadSeat;
    match.current = null;
    match.passes = 0;
    match.lastPlays = [null, null, null, null];
    if (match.hands[winner].length === 0) {
      const partner = partnerOf(winner);
      match.turn = match.hands[partner].length ? partner : nextSeatWithCards(match, winner);
      addLog(match, `${match.names[match.turn]} 接风`);
    } else {
      match.turn = winner;
      addLog(match, `${match.names[winner]} 继续出`);
    }
  }
  return { ok: true };
}

// 自己已经出完而队友还有牌时，允许看队友的手牌
function spectatorView(match, viewerSeat) {
  if (viewerSeat == null || match.phase !== "play") return null;
  if (match.hands[viewerSeat].length) return null;
  const partner = partnerOf(viewerSeat);
  if (!match.hands[partner].length) return null;
  return { seat: partner, name: match.names[partner], hand: sortHand(match.hands[partner], levelRankOf(match)) };
}

// 记牌器：每种点数还剩多少张没露面（已出的和自己手里的都扣掉）
export function remainingCounts(match, viewerSeat = null) {
  const counts = {};
  for (let rank = 3; rank <= 17; rank += 1) counts[rank] = rank >= 16 ? 2 : 8;
  for (const card of match.playedCards ?? []) counts[card.rank] -= 1;
  if (viewerSeat != null) {
    for (const card of match.hands[viewerSeat] ?? []) counts[card.rank] -= 1;
  }
  for (let rank = 3; rank <= 17; rank += 1) counts[rank] = Math.max(0, counts[rank]);
  return counts;
}

export function publicState(match, viewerSeat = null) {
  const levelRank = levelRankOf(match);
  return {
    names: match.names,
    bots: match.bots,
    difficulty: normalizeDifficulty(match.difficulty),
    phase: match.phase,
    round: match.round,
    levelRank,
    levelLabel: levelLabel(levelRank),
    teamLevel: match.teamLevel.map(levelLabel),
    bankerTeam: match.bankerTeam,
    turn: match.turn,
    leadSeat: match.leadSeat,
    current: match.current,
    lastPlay: match.lastPlay,
    lastPlays: match.lastPlays,
    finishOrder: match.finishOrder,
    handsCount: match.hands.map((hand) => hand.length),
    hand: viewerSeat == null ? [] : sortHand(match.hands[viewerSeat], levelRank),
    returnsPlan: match.returnsPlan,
    tributePlan: match.tributePlan,
    tributeRefused: match.tributeRefused ?? [],
    tributeSummary: match.tributeSummary ?? [],
    spectate: spectatorView(match, viewerSeat),
    remaining: remainingCounts(match, viewerSeat),
    roundResult: match.roundResult,
    winnerTeam: match.winnerTeam,
    log: match.log.slice(-12),
    viewerSeat
  };
}

export function autoAct(match, seat, rng = Math.random) {
  if (seat == null || !match.hands[seat]) return { ok: false, error: "座位无效" };
  const levelRank = levelRankOf(match);
  if (match.phase === "returnTribute") {
    const allowed = returnableCards(match.hands[seat], levelRank);
    const pick = chooseReturnCard(match.hands[seat], allowed, levelRank, match.difficulty, rng);
    return returnTribute(match, seat, (pick ?? allowed[0])?.id);
  }
  if (match.phase !== "play" || match.turn !== seat) return { ok: false };
  const hand = match.hands[seat];
  let decision = null;
  try {
    decision = chooseAction(match, seat, levelRank, match.difficulty, rng);
  } catch {
    decision = null;
  }
  if (decision?.action === "play" && decision.cardIds?.length) {
    const result = playCards(match, seat, decision.cardIds, decision.reason, decision.comboKey ?? null, false);
    if (result.ok) return result;
  }
  if (decision?.action === "pass" && match.current) return passTurn(match, seat, decision.reason);

  // Safety net so the table never stalls if the planner finds nothing legal.
  const plays = generatePlays(hand, levelRank, match.current);
  const goingOut = plays.filter((combo) => combo.cards.length === hand.length);
  if (goingOut.length) {
    return playCards(match, seat, goingOut[0].cards.map((card) => card.id), "一把走完", comboKey(goingOut[0]), false);
  }
  if (!match.current) {
    const lead = plays[0];
    if (!lead) return { ok: false, error: "无牌可出" };
    return playCards(match, seat, lead.cards.map((card) => card.id), "领出", comboKey(lead), false);
  }
  const cheap = plays.filter((combo) => !combo.bombPower || hand.length <= 8);
  const choice = cheap[0] ?? null;
  if (!choice) return passTurn(match, seat, "压不住");
  return playCards(match, seat, choice.cards.map((card) => card.id), "压上家", comboKey(choice), false);
}
