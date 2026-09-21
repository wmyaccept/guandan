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
import { canBeat, comboLabel, parseCombo } from "./combos.js";
import { generatePlays } from "./moves.js";

const TEAM_NAMES = ["南北", "东西"];

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
    teamLevel: [15, 15],
    bankerTeam: 0,
    round: 0,
    winnerTeam: null,
    log: [],
    phase: "deal",
    hands: [[], [], [], []],
    lastHands: [[], [], [], []],
    finishOrder: [],
    current: null,
    leadSeat: 0,
    turn: 0,
    passes: 0,
    lastPlay: null,
    lastPlays: [null, null, null, null],
    tributePlan: [],
    returnsPlan: [],
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

function hasDoubleBigJoker(hand) {
  return hand.filter((card) => card.rank === 17).length >= 2;
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

function buildTribute(match) {
  const finish = match.finishOrder;
  const kind = upgradeFor(finish).kind;
  match.tributePlan = [];
  match.returnsPlan = [];
  if (kind === "双下") return false;

  const head = finish[0];
  const last = finish[3];
  const levelRank = levelRankOf(match);

  if (kind === "头三") {
    if (hasDoubleBigJoker(match.hands[last])) {
      addLog(match, `${match.names[last]} 双大王抗贡`);
      return false;
    }
    match.tributePlan.push({ from: last, to: head, cardId: highestCard(match.hands[last], levelRank).id });
    return true;
  }

  const midA = finish[1];
  const midB = finish[2];
  const givers = [midA, midB].filter((seat) => !hasDoubleBigJoker(match.hands[seat]));
  for (const seat of [midA, midB]) {
    if (!givers.includes(seat)) addLog(match, `${match.names[seat]} 双大王抗贡`);
  }
  if (!givers.length) return false;
  const gifts = givers
    .map((seat) => ({ from: seat, card: highestCard(match.hands[seat], levelRank) }))
    .sort((a, b) => compareCards(a.card, b.card, levelRank));
  const high = gifts.at(-1);
  match.tributePlan.push({ from: high.from, to: head, cardId: high.card.id });
  if (gifts.length > 1) {
    const low = gifts[0];
    match.tributePlan.push({ from: low.from, to: last, cardId: low.card.id });
  }
  return match.tributePlan.length > 0;
}

function applyTribute(match) {
  for (const step of match.tributePlan) {
    const card = takeCard(match.hands[step.from], step.cardId);
    if (!card) continue;
    giveCard(match, step.from, step.to, card);
    addLog(match, `${match.names[step.from]} 进贡 ${cardLabel(card)} 给 ${match.names[step.to]}`);
    match.returnsPlan.push({ from: step.to, to: step.from });
  }
}

function returnableCards(hand, levelRank) {
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
  addLog(match, `${match.names[seat]} 还贡 ${cardLabel(taken)} 给 ${match.names[step.to]}`);
  match.returnsPlan = match.returnsPlan.filter((item) => item.from !== seat);
  if (!match.returnsPlan.length) {
    beginPlay(match, match.nextLead, `${match.names[match.nextLead]} 还贡完毕，先出`);
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

export function playCards(match, seat, cardIds) {
  if (match.phase !== "play") return { ok: false, error: "还没轮到出牌" };
  if (match.turn !== seat) return { ok: false, error: "没轮到你" };
  const hand = match.hands[seat];
  const cards = cardIds.map((id) => hand.find((card) => card.id === id)).filter(Boolean);
  if (cards.length !== cardIds.length) return { ok: false, error: "手里没有这些牌" };
  const preferred = match.current && !match.current.bombPower ? match.current.type : null;
  const combo = parseCombo(cards, levelRankOf(match), preferred);
  if (!combo) return { ok: false, error: "这不是合法牌型" };
  if (match.current && !canBeat(combo, match.current)) return { ok: false, error: "压不住上家" };
  if (!match.current && combo.cards.length === 0) return { ok: false, error: "必须出牌" };

  for (const id of cardIds) takeCard(hand, id);
  match.hands[seat] = sortHand(hand, levelRankOf(match));
  match.current = combo;
  match.lastPlay = { seat, combo };
  match.lastPlays[seat] = combo;
  match.passes = 0;
  match.leadSeat = seat;
  addLog(match, `${match.names[seat]} 出 ${comboLabel(combo)} ${combo.cards.map(cardLabel).join(" ")}`);

  if (match.hands[seat].length === 0) {
    finishSeat(match, seat);
    if (match.phase !== "play") return { ok: true };
  }
  match.turn = nextSeatWithCards(match, seat);
  return { ok: true };
}

export function passTurn(match, seat) {
  if (match.phase !== "play") return { ok: false, error: "还没轮到出牌" };
  if (match.turn !== seat) return { ok: false, error: "没轮到你" };
  if (!match.current) return { ok: false, error: "首出不能过" };
  match.lastPlays[seat] = { type: "pass", label: "过", cards: [] };
  addLog(match, `${match.names[seat]} 不要`);
  match.turn = nextSeatWithCards(match, seat);
  match.passes += 1;

  const remaining = [0, 1, 2, 3].filter((item) => match.hands[item].length > 0);
  if (match.passes >= remaining.length - 1) {
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

export function publicState(match, viewerSeat = null) {
  const levelRank = levelRankOf(match);
  return {
    names: match.names,
    bots: match.bots,
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
    hand: viewerSeat == null ? [] : match.hands[viewerSeat],
    returnsPlan: match.returnsPlan,
    tributePlan: match.tributePlan,
    roundResult: match.roundResult,
    winnerTeam: match.winnerTeam,
    log: match.log.slice(-12),
    viewerSeat
  };
}

export function autoAct(match, seat) {
  if (seat == null || !match.hands[seat]) return { ok: false, error: "座位无效" };
  const levelRank = levelRankOf(match);
  if (match.phase === "returnTribute") {
    const allowed = returnableCards(match.hands[seat], levelRank);
    return returnTribute(match, seat, allowed[0]?.id);
  }
  if (match.phase !== "play" || match.turn !== seat) return { ok: false };
  const plays = generatePlays(match.hands[seat], levelRank, match.current);
  const goingOut = plays.filter((combo) => combo.cards.length === match.hands[seat].length);
  if (goingOut.length) return playCards(match, seat, goingOut[0].cards.map((card) => card.id));
  if (!match.current) {
    const lead = plays[0];
    if (!lead) return { ok: false, error: "无牌可出" };
    return playCards(match, seat, lead.cards.map((card) => card.id));
  }
  const cheap = plays.filter((combo) => !combo.bombPower || match.hands[seat].length <= 8);
  const choice = cheap[0] ?? null;
  if (!choice) return passTurn(match, seat);
  return playCards(match, seat, choice.cards.map((card) => card.id));
}
