const socket = io();
const $ = (id) => document.getElementById(id);
const selected = new Set();
let state = null;
let you = -1;
let handPiles = [];
let handPilesCustom = false;
let handOwner = null;
const pilesByOwner = new Map();
let spectateOn = false;
let spectatingNow = false;
let displayed = null;
let stateQueue = [];
let lastRevealAt = 0;
let pumping = false;
let clockTimer = null;
let trickKey = "";
let shakeTimer = null;
let pendingReconnect = false;
let myTurnSeen = false;
let renderEpoch = 0;
let audioCtx = null;

const REVEAL_MS = 2200;
const RANK = {
  3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10",
  11: "J", 12: "Q", 13: "K", 14: "A", 15: "2", 16: "xiaowang", 17: "dawang"
};
RANK[16] = "\u5c0f\u738b";
RANK[17] = "\u5927\u738b";
const SUIT = { S: "\u2660", H: "\u2665", D: "\u2666", C: "\u2663", J: "\u738b" };

const savedName = localStorage.getItem("guandan-name") || "";
$("name").value = savedName || ("\u73a9\u5bb6" + Math.floor(Math.random() * 90 + 10));

const SESSION_KEY = "guandan-session";
const TOKEN_KEY = "guandan-token";
const ZOOM_KEY = "guandan-zoom";
const SOUND_KEY = "guandan-sound";
const COUNTER_KEY = "guandan-counter";
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 1.6;
const ZOOM_STEP = 0.1;

function clampZoom(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(n * 10) / 10));
}

let zoom = clampZoom(localStorage.getItem(ZOOM_KEY) || 1);
let soundOn = localStorage.getItem(SOUND_KEY) !== "off";
let counterOn = localStorage.getItem(COUNTER_KEY) === "on";

function applyZoom() {
  document.documentElement.style.setProperty("--zoom", String(zoom));
  $("zoomOutBtn").disabled = zoom <= ZOOM_MIN;
  $("zoomInBtn").disabled = zoom >= ZOOM_MAX;
}

function setZoom(value) {
  zoom = clampZoom(value);
  localStorage.setItem(ZOOM_KEY, String(zoom));
  applyZoom();
}

function applySound() {
  $("soundBtn").classList.toggle("muted", !soundOn);
  $("soundBtn").setAttribute("aria-pressed", soundOn ? "true" : "false");
}

function applyCounter() {
  const btn = $("counterBtn");
  if (!btn) return;
  btn.classList.toggle("on", counterOn);
  btn.setAttribute("aria-pressed", counterOn ? "true" : "false");
}

/* ---------------- appearance: card skin and table cloth ---------------- */
const SKIN_KEY = "guandan-card-skin";
const FELT_KEY = "guandan-felt";
const CARD_SKINS = [
  { id: "classic", name: "\u7ecf\u5178" },
  { id: "pearl", name: "\u6708\u767d" },
  { id: "kraft", name: "\u725b\u76ae\u7eb8" },
  { id: "ink", name: "\u58a8\u9ed1" },
  { id: "jade", name: "\u9752\u7389" }
];
const FELTS = [
  { id: "green", name: "\u7fe1\u7fe0\u7eff" },
  { id: "blue", name: "\u6df1\u6d77\u84dd" },
  { id: "wine", name: "\u9152\u7ea2" },
  { id: "plum", name: "\u7d2b\u6885" },
  { id: "walnut", name: "\u80e1\u6843\u6728" },
  { id: "slate", name: "\u77f3\u677f\u7070" }
];
const SKIN_IDS = CARD_SKINS.map((skin) => skin.id);
const FELT_IDS = FELTS.map((felt) => felt.id);

function readChoice(key, ids, fallback) {
  let value = null;
  try {
    value = localStorage.getItem(key);
  } catch {}
  return ids.includes(value) ? value : fallback;
}

let cardSkin = readChoice(SKIN_KEY, SKIN_IDS, "classic");
let feltColor = readChoice(FELT_KEY, FELT_IDS, "green");

function markChoice(row, attr, value) {
  for (const node of document.querySelectorAll(row + " .opt")) {
    const on = node.dataset[attr] === value;
    node.classList.toggle("on", on);
    node.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

function applyAppearance() {
  document.documentElement.dataset.cardSkin = cardSkin;
  document.documentElement.dataset.felt = feltColor;
  markChoice("#cardSkins", "skin", cardSkin);
  markChoice("#feltColors", "felt", feltColor);
}

function setCardSkin(id) {
  if (!SKIN_IDS.includes(id) || id === cardSkin) return;
  cardSkin = id;
  try {
    localStorage.setItem(SKIN_KEY, id);
  } catch {}
  applyAppearance();
}

function setFelt(id) {
  if (!FELT_IDS.includes(id) || id === feltColor) return;
  feltColor = id;
  try {
    localStorage.setItem(FELT_KEY, id);
  } catch {}
  applyAppearance();
}

// Stable per browser so a reload can claim the very same seat back,
// even when the server has not noticed the old connection die yet.
function deviceToken() {
  let token = null;
  try {
    token = localStorage.getItem(TOKEN_KEY);
  } catch {}
  if (!token) {
    token = window.crypto?.randomUUID
      ? window.crypto.randomUUID()
      : "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {}
  }
  return token;
}

function readSession() {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    return raw && raw.code ? raw : null;
  } catch {
    return null;
  }
}

function saveSession(code, name) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ code, name }));
  } catch {}
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function ensureAudio() {
  if (audioCtx) {
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  audioCtx = new Ctx();
  return audioCtx;
}

function playTurnChime() {
  if (!soundOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const start = ctx.currentTime + 0.01;
  [880, 1174.7].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const t0 = start + i * 0.14;
    osc.type = "triangle";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.32);
  });
  if (navigator.vibrate) navigator.vibrate([50, 40, 60]);
}

/* ---------------- combo sounds: cloth slap plus a flourish per shape ---------------- */
let noiseBuffer = null;

function makeNoise(ctx) {
  if (noiseBuffer) return noiseBuffer;
  const len = Math.floor(ctx.sampleRate * 0.4);
  noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
  return noiseBuffer;
}

function noiseHit(ctx, at, dur, peak, freq, kind) {
  const src = ctx.createBufferSource();
  src.buffer = makeNoise(ctx);
  const filter = ctx.createBiquadFilter();
  filter.type = kind || "bandpass";
  filter.frequency.value = freq;
  filter.Q.value = 0.7;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  src.start(at);
  src.stop(at + dur + 0.03);
}

function toneHit(ctx, at, freq, dur, peak, kind) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = kind || "triangle";
  osc.frequency.setValueAtTime(freq, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.03);
}

function sweepDown(ctx, at, from, to, dur, peak) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(to, at + dur);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur + 0.08);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.12);
}

const RUN_STEPS = [0, 3, 7, 10, 14, 17, 20, 24];

function noiseWhoosh(ctx, at, dur, peak, from, to, q) {
  const src = ctx.createBufferSource();
  src.buffer = makeNoise(ctx);
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = q || 1.6;
  filter.frequency.setValueAtTime(from, at);
  filter.frequency.exponentialRampToValueAtTime(to, at + dur);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + dur * 0.32);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  src.start(at);
  src.stop(at + dur + 0.05);
}

function woodKnock(ctx, at, freq, dur, peak) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, at);
  osc.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.5), at + dur);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

function metalClang(ctx, at, base, dur, peak) {
  [1, 2.76, 5.4, 8.93].forEach((ratio, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = i === 0 ? "triangle" : "square";
    osc.frequency.setValueAtTime(base * ratio, at);
    const level = peak / (1 + i * 1.6);
    const life = dur * (1 - i * 0.14);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(level, at + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + life);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(at);
    osc.stop(at + life + 0.06);
  });
}

// every shape gets its own voice: running water for straights, wood for the board,
// steel for the plate, sparkle for the flush straight, rumble for bombs.
function playComboSound(combo) {
  if (!soundOn || !combo) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const at = ctx.currentTime + 0.01;
  const size = combo.cards?.length ?? 1;
  const type = combo.type;

  if (type === "straight") {
    noiseWhoosh(ctx, at, 0.5, 0.26, 620, 2800, 2.4);
    RUN_STEPS.slice(0, 4).forEach((semi, i) => {
      toneHit(ctx, at + 0.05 + i * 0.06, 523.25 * Math.pow(2, semi / 12), 0.22, 0.05, "sine");
    });
    return;
  }
  if (type === "pairseq") {
    const pairs = Math.max(2, Math.min(3, Math.round(size / 2)));
    for (let i = 0; i < pairs; i += 1) {
      woodKnock(ctx, at + i * 0.11, 210 - i * 14, 0.17, 0.36);
      noiseHit(ctx, at + i * 0.11, 0.06, 0.12, 780, "lowpass");
    }
    return;
  }
  if (type === "tripleseq") {
    for (let i = 0; i < 2; i += 1) metalClang(ctx, at + i * 0.17, 640 + i * 70, 0.5, 0.15);
    noiseHit(ctx, at, 0.09, 0.1, 3600, "highpass");
    return;
  }
  if (type === "flushstraight") {
    [0, 4, 7, 12, 16, 19].forEach((semi, i) => {
      toneHit(ctx, at + 0.04 + i * 0.05, 523.25 * Math.pow(2, semi / 12), 0.42, 0.1, "sine");
    });
    noiseWhoosh(ctx, at, 0.42, 0.11, 1600, 5200, 1.1);
    return;
  }

  noiseHit(ctx, at, 0.12, size >= 5 ? 0.3 : 0.2, 1800, "bandpass");
  if (type === "fullhouse") {
    toneHit(ctx, at + 0.06, 349.23, 0.2, 0.15, "triangle");
    toneHit(ctx, at + 0.2, 523.25, 0.28, 0.15, "triangle");
  } else if (type === "bomb") {
    const big = size >= 6;
    sweepDown(ctx, at, big ? 200 : 155, 46, big ? 0.55 : 0.4, big ? 0.5 : 0.36);
    noiseHit(ctx, at, big ? 0.42 : 0.3, big ? 0.3 : 0.22, 240, "lowpass");
  } else if (type === "jokerbomb") {
    sweepDown(ctx, at, 250, 36, 0.78, 0.55);
    noiseHit(ctx, at, 0.5, 0.34, 190, "lowpass");
    [0, 7, 12, 19].forEach((semi, i) => {
      toneHit(ctx, at + 0.1 + i * 0.05, 784 * Math.pow(2, semi / 12), 0.42, 0.09, "sine");
    });
  }
}

const savedSession = readSession();
if (savedSession) $("code").value = savedSession.code;
applyZoom();
applySound();
applyCounter();
applyAppearance();
["pointerdown", "keydown"].forEach((evt) => {
  window.addEventListener(evt, () => ensureAudio(), { once: true });
});

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add("hidden"), 2200);
}

function cardClass(card, levelRank) {
  const classes = ["card"];
  if (card.suit === "H" || card.suit === "D") classes.push("red");
  if (card.rank >= 16) classes.push("joker");
  if (card.suit === "H" && card.rank === levelRank) classes.push("wild");
  return classes.join(" ");
}

function renderCard(card, levelRank, representedRank = null) {
  const div = document.createElement("button");
  div.type = "button";
  div.className = cardClass(card, levelRank);
  div.dataset.id = card.id;
  const rank = RANK[card.rank];
  const suit = SUIT[card.suit] ?? "";
  const wild = card.suit === "H" && card.rank === levelRank;
  const wildLabel = representedRank == null
    ? "配"
    : "配" + (RANK[representedRank] ?? representedRank);
  div.innerHTML = '<span class="pip">' + suit + '</span>' +
    '<span class="corner"><strong>' + rank + '</strong><small>' + suit + '</small></span>' +
    (wild ? '<span class="wild-mark">' + wildLabel + '</span>' : '');
  return div;
}

function remainLabel(count) {
  if (count <= 0) return "\u51fa\u5b8c";
  if (count <= 10) return count + "\u5f20";
  return "";
}

function groupByRank(cards) {
  const groups = [];
  for (const card of cards) {
    const last = groups.at(-1);
    if (last && last.rank === card.rank) last.ids.push(card.id);
    else groups.push({ rank: card.rank, ids: [card.id] });
  }
  return groups.map((group) => group.ids);
}

function syncPiles(cards) {
  const byId = new Map(cards.map((card) => [card.id, card]));
  if (!handPilesCustom) {
    handPiles = groupByRank(cards);
    return;
  }
  const keptAny = handPiles.some((pile) => pile.some((id) => byId.has(id)));
  if (!keptAny) {
    handPiles = groupByRank(cards);
    return;
  }
  const next = [];
  for (const pile of handPiles) {
    const kept = [];
    for (const id of pile) {
      if (!byId.has(id)) continue;
      kept.push(id);
      byId.delete(id);
    }
    if (kept.length) next.push(kept);
  }
  for (const card of cards) {
    if (!byId.has(card.id)) continue;
    const pile = next.find((item) => byId.get(item[0])?.rank === card.rank || cards.find((c) => c.id === item[0])?.rank === card.rank);
    if (pile) pile.push(card.id);
    else next.push([card.id]);
    byId.delete(card.id);
  }
  handPiles = next;
}

function groupSelected() {
  if (spectatingNow) {
    toast("看队友的牌时不能组牌");
    return;
  }
  const ids = [];
  for (const pile of handPiles) {
    for (const id of pile) if (selected.has(id)) ids.push(id);
  }
  if (ids.length < 2) {
    toast("先选至少两张牌");
    return;
  }
  const firstIndex = handPiles.findIndex((pile) => pile.some((id) => selected.has(id)));
  const next = handPiles.map((pile) => pile.filter((id) => !selected.has(id))).filter((pile) => pile.length);
  next.splice(Math.max(0, Math.min(firstIndex, next.length)), 0, ids);
  handPiles = next;
  handPilesCustom = true;
  selected.clear();
  if (state) renderHand(state.match);
}

const AVATAR_COLORS = ["#c05f45", "#3d7d68", "#4a6fa5", "#a8763c", "#7a5a9c", "#4f8a5b"];

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}

function avatarColor(name) {
  let hash = 0;
  for (const ch of String(name ?? "")) hash = (hash * 31 + ch.codePointAt(0)) % 9973;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function avatarInitial(name) {
  const text = String(name ?? "").trim();
  if (!text) return "?";
  const first = [...text][0];
  return /[A-Za-z]/.test(first) ? first.toUpperCase() : first;
}

function avatarHtml(person, seat) {
  if (!person) return '<span class="avatar avatar-empty">\u7a7a</span>';
  return '<button type="button" class="avatar" data-seat="' + seat + '" style="--av:' + avatarColor(person.name) +
    '" title="\u7838\u86cb / \u9001\u82b1">' + escapeHtml(avatarInitial(person.name)) + "</button>";
}

function renderSeats(room) {
  const match = room.match;
  const waiting = !match;
  document.querySelectorAll(".seat").forEach((node) => {
    const view = Number(node.dataset.view);
    const seat = you < 0 ? view : (you + view) % 4;
    node.dataset.seat = String(seat);
    const person = room.seats[seat];
    const count = match?.handsCount?.[seat] ?? 0;
    const mine = seat === you;
    const pickable = waiting && !mine && (!person || person.bot);
    const bits = [];
    if (person?.hosted) bits.push("\u6258\u7ba1\u4e2d");
    else if (person?.bot) bits.push("\u673a\u5668\u4eba");
    else if (person && !person.connected) bits.push("\u79bb\u7ebf");
    if (waiting && mine) bits.push("\u6211\u7684\u5ea7\u4f4d");
    if (pickable) bits.push("\u70b9\u51fb\u5165\u5ea7");
    const remain = remainLabel(count);
    if (remain) bits.push(remain);
    node.classList.toggle("turn", Boolean(match && match.turn === seat && (match.phase === "play" || match.phase === "returnTribute")));
    node.classList.toggle("me", mine);
    node.classList.toggle("pick", pickable);
    node.innerHTML = avatarHtml(person, seat) +
      '<div class="seat-text"><b>' + escapeHtml(person?.name ?? "\u7a7a\u4f4d") + "</b><span>" +
      (bits.join(" \u00b7 ") || " ") + "</span></div>";
  });
}

function renderSelf(room) {
  const el = $("selfStatus");
  if (!el) return;
  const seat = you >= 0 ? you : 0;
  const person = room.seats[seat];
  const match = room.match;
  const remain = remainLabel(match?.handsCount?.[seat] ?? 0);
  const watch = spectatingNow ? spectateInfo(match) : null;
  const tag = watch ? '<span class="tag">正在看 ' + escapeHtml(watch.name ?? "队友") + " 的牌</span>" : "";
  el.innerHTML = "<b>" + escapeHtml(person?.name ?? "") + "</b>" + (remain ? "<span>" + remain + "</span>" : "") + tag;
  el.classList.toggle("turn", Boolean(match && you === match.turn && (match.phase === "play" || match.phase === "returnTribute")));
}

function hasModestReturnCard(cards, levelRank) {
  // 2的内部等级是15，还贡时2到10都可以还。
  return cards.some(
    (card) => ((card.rank >= 3 && card.rank <= 10) || card.rank === 15) && card.rank !== levelRank
  );
}

function canPickForReturn(card, match, cards = effectiveHand(match)) {
  // 级牌不能还；手里没有2到10的牌时才放开兜底，但级牌仍排除。
  if (!hasModestReturnCard(cards, match.levelRank)) return card.rank !== match.levelRank;
  return ((card.rank >= 3 && card.rank <= 10) || card.rank === 15) && card.rank !== match.levelRank;
}

function toggleSelect(id, node) {
  const match = state?.match;
  if (match?.phase === "returnTribute") {
    const card = effectiveHand(match).find((item) => item.id === id);
    if (card && !canPickForReturn(card, match)) {
      toast("还贡只能选2至10且不是当前级牌的牌");
      return;
    }
  }
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  node.classList.toggle("up", selected.has(id));
}

let pendingComboChoice = null;

function closeComboChoice() {
  pendingComboChoice = null;
  selected.clear();
  if (state) renderHand(state.match);
  $("comboChoice")?.classList.add("hidden");
}

function openComboChoice({ cardIds, options } = {}) {
  if (!Array.isArray(options) || !options.length) return;
  selected.clear();
  for (const id of cardIds ?? []) selected.add(id);
  pendingComboChoice = { cardIds: (cardIds ?? []).slice(), options };
  if (state) renderHand(state.match);
  const holder = $("comboOptions");
  holder.textContent = "";
  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "combo-option";
    const title = document.createElement("strong");
    title.textContent = option.label;
    const detail = document.createElement("span");
    detail.textContent = option.detail;
    button.append(title, detail);
    button.addEventListener("click", () => {
      const payload = pendingComboChoice;
      if (!payload) return;
      closeComboChoice();
      socket.emit("play", { cardIds: payload.cardIds, comboKey: option.key });
    });
    holder.append(button);
  }
  $("comboChoice").classList.remove("hidden");
}

/* ---------------- partner view: watch your teammate once you are out ---------------- */
function spectateInfo(match) {
  const info = match?.spectate;
  return info && Array.isArray(info.hand) && info.hand.length ? info : null;
}

function effectiveHand(match) {
  if (spectateOn) {
    const info = spectateInfo(match);
    if (info) return info.hand;
  }
  return match?.hand ?? [];
}

function ownerKey(match) {
  const info = spectateOn ? spectateInfo(match) : null;
  const owner = info ? "partner-" + info.seat : "self";
  return owner + "@" + (match?.round ?? 0);
}

function updateSpectate(match) {
  const btn = $("spectateBtn");
  if (!btn) return false;
  const info = match?.phase === "play" ? spectateInfo(match) : null;
  const wrap = document.querySelector(".hand-wrap");
  if (!info) {
    spectateOn = false;
    btn.classList.add("hidden");
    btn.classList.remove("on");
    btn.setAttribute("aria-pressed", "false");
    wrap?.classList.remove("spectating");
    return false;
  }
  btn.classList.remove("hidden");
  btn.classList.toggle("on", spectateOn);
  btn.setAttribute("aria-pressed", spectateOn ? "true" : "false");
  btn.title = spectateOn ? "回到自己的视角" : "看 " + (info.name ?? "队友") + " 的牌";
  wrap?.classList.toggle("spectating", spectateOn);
  return spectateOn;
}

/* ---------------- card counter: ranks that have not shown up yet ---------------- */
function counterOrder(levelRank) {
  const order = [17, 16];
  if (levelRank >= 3 && levelRank <= 15) order.push(levelRank);
  for (let rank = 14; rank >= 3; rank -= 1) if (rank !== levelRank) order.push(rank);
  if (levelRank !== 15) order.push(15);
  return order;
}

function counterCounts(match) {
  const counts = { ...(match?.remaining ?? {}) };
  if (spectatingNow) {
    for (const card of spectateInfo(match)?.hand ?? []) {
      if (counts[card.rank] != null) counts[card.rank] = Math.max(0, counts[card.rank] - 1);
    }
  }
  return counts;
}

function renderCounter(match) {
  const panel = $("counter");
  const btn = $("counterBtn");
  if (!panel || !btn) return;
  const live = Boolean(match && match.remaining && match.phase !== "matchOver");
  btn.classList.toggle("hidden", !live);
  if (!live || !counterOn) {
    panel.classList.add("hidden");
    return;
  }
  const counts = counterCounts(match);
  const grid = $("counterGrid");
  grid.textContent = "";
  let unseen = 0;
  for (const rank of counterOrder(match.levelRank)) {
    const left = counts[rank] ?? 0;
    unseen += left;
    const cell = document.createElement("span");
    const classes = ["counter-cell"];
    if (rank >= 16) classes.push("big");
    if (rank === match.levelRank) classes.push("lv");
    if (!left) classes.push("out");
    cell.className = classes.join(" ");
    const name = document.createElement("i");
    name.textContent = RANK[rank] ?? String(rank);
    const num = document.createElement("b");
    num.textContent = String(left);
    cell.append(name, num);
    grid.append(cell);
  }
  $("counterNote").textContent = "未见 " + unseen + " 张";
  panel.classList.remove("hidden");
}

function renderHand(match) {
  const hand = $("hand");
  hand.innerHTML = "";
  if (!match) {
    handPiles = [];
    handPilesCustom = false;
    handOwner = null;
    return;
  }
  // Each view and round has its own layout. A new deal starts from the
  // server-sorted hand; manual grouping is preserved until the round changes.
  const key = ownerKey(match);
  if (handOwner !== key) {
    if (handOwner) {
      pilesByOwner.set(handOwner, {
        piles: handPiles.map((pile) => pile.slice()),
        custom: handPilesCustom
      });
    }
    const saved = pilesByOwner.get(key);
    handOwner = key;
    handPiles = (saved?.piles ?? []).map((pile) => pile.slice());
    handPilesCustom = saved?.custom ?? false;
  }
  const cards = effectiveHand(match);
  syncPiles(cards);
  const byId = new Map(cards.map((card) => [card.id, card]));
  const returning = match?.phase === "returnTribute";
  handPiles.forEach((pile, index) => {
    const col = document.createElement("div");
    col.className = "pile";
    col.dataset.index = String(index);
    for (const id of pile) {
      const card = byId.get(id);
      if (!card) continue;
      const node = renderCard(card, match.levelRank);
      if (selected.has(card.id)) node.classList.add("up");
      if (returning && !canPickForReturn(card, match, cards)) node.classList.add("return-invalid");
      col.append(node);
    }
    hand.append(col);
  });
}

function applyDrop(id, dest) {
  const sourceIndex = handPiles.findIndex((pile) => pile.includes(id));
  if (sourceIndex < 0) return;
  const next = handPiles.map((pile) => pile.filter((item) => item !== id));
  const vanished = next[sourceIndex].length === 0;
  if (vanished) next.splice(sourceIndex, 1);
  if (dest.type === "onto") {
    if (dest.self) {
      next.splice(Math.max(0, Math.min(sourceIndex, next.length)), 0, [id]);
    } else {
      let target = dest.pile;
      if (vanished && sourceIndex < dest.pile) target -= 1;
      if (target < 0 || target >= next.length) next.push([id]);
      else next[target].splice(Math.max(0, Math.min(dest.offset, next[target].length)), 0, id);
    }
  } else {
    let index = dest.index;
    if (vanished && sourceIndex < index) index -= 1;
    next.splice(Math.max(0, Math.min(index, next.length)), 0, [id]);
  }
  handPiles = next.filter((pile) => pile.length);
  handPilesCustom = true;
}

function locateDrop(x, y, draggedId) {
  const pileEls = [...$("hand").querySelectorAll(".pile")];
  for (let i = 0; i < pileEls.length; i += 1) {
    const box = pileEls[i].getBoundingClientRect();
    if (x >= box.left - 12 && x <= box.right + 12 && y >= box.top - 32 && y <= box.bottom + 28) {
      const cards = [...pileEls[i].querySelectorAll(".card")].filter((card) => card.dataset.id !== draggedId);
      if (!cards.length) return { type: "onto", pile: i, offset: 0, self: true };
      let offset = cards.length;
      for (let j = 0; j < cards.length; j += 1) {
        const cb = cards[j].getBoundingClientRect();
        if (y < cb.top + cb.height * 0.55) {
          offset = j;
          break;
        }
      }
      return { type: "onto", pile: i, offset, self: false };
    }
  }
  let index = pileEls.length;
  for (let i = 0; i < pileEls.length; i += 1) {
    const box = pileEls[i].getBoundingClientRect();
    if (x < (box.left + box.right) / 2) {
      index = i;
      break;
    }
  }
  return { type: "new", index };
}

function clearDropTargets() {
  $("hand").querySelectorAll(".pile").forEach((pile) => pile.classList.remove("drop-target"));
}

function bindHandDrag() {
  const hand = $("hand");
  let drag = null;

  hand.addEventListener("pointerdown", (event) => {
    if (spectatingNow) return;
    const node = event.target.closest(".card");
    if (!node || event.button !== 0) return;
    drag = {
      node,
      id: node.dataset.id,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      pointerId: event.pointerId
    };
    node.setPointerCapture(event.pointerId);
  });

  hand.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 8) return;
    drag.moved = true;
    drag.node.classList.add("dragging");
    clearDropTargets();
    const dest = locateDrop(event.clientX, event.clientY, drag.id);
    if (dest.type === "onto" && !dest.self) {
      const pile = hand.querySelectorAll(".pile")[dest.pile];
      if (pile) pile.classList.add("drop-target");
    }
  });

  const finish = (event, cancelled) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const current = drag;
    drag = null;
    current.node.classList.remove("dragging");
    clearDropTargets();
    if (cancelled) return;
    if (current.moved) {
      applyDrop(current.id, locateDrop(event.clientX, event.clientY, current.id));
      if (state) renderHand(state.match);
    } else {
      toggleSelect(current.id, current.node);
    }
  };

  hand.addEventListener("pointerup", (event) => finish(event, false));
  hand.addEventListener("pointercancel", (event) => finish(event, true));
}

/* ---------------- avatar gestures: throw an egg, send flowers ---------------- */
const GESTURE_KINDS = {
  egg: {
    label: "\u7838\u86cb",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="14" rx="7" ry="8.4"/><path d="M8 6.4 9.8 4l2 2.2L14 4l1.8 2.3"/></svg>',
    fly: '<svg viewBox="0 0 32 40" aria-hidden="true"><ellipse cx="16" cy="23" rx="11.4" ry="14" fill="#fff8ec" stroke="#cdbfa2" stroke-width="1.3"/><ellipse cx="12.4" cy="18" rx="3.2" ry="4.4" fill="#fffdf7"/></svg>'
  },
  flower: {
    label: "\u9001\u82b1",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.4" r="2.6"/><circle cx="8.2" cy="11.8" r="2.6"/><circle cx="15.8" cy="11.8" r="2.6"/><path d="M12 12.4V21M12 17l3-2M12 19l-3-2"/></svg>',
    fly: '<svg viewBox="0 0 40 40" aria-hidden="true"><g fill="#f2789f"><circle cx="20" cy="10" r="6"/><circle cx="11" cy="17" r="6"/><circle cx="29" cy="17" r="6"/></g><circle cx="20" cy="16" r="4" fill="#ffd76a"/><path d="M20 21v15" stroke="#4f9a5f" stroke-width="3" fill="none" stroke-linecap="round"/></svg>'
  }
};
let gesturePopSeat = -1;

function seatAnchor(seat) {
  const node = document.querySelector('.seat[data-seat="' + seat + '"] .avatar');
  if (node && node.offsetParent) {
    const box = node.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }
  return { x: window.innerWidth / 2, y: window.innerHeight - 48 };
}

function burstHtml(kind) {
  const parts = [];
  const bits = kind === "flower" ? 10 : 8;
  const cls = kind === "flower" ? "petal" : "shard";
  parts.push(kind === "flower" ? '<span class="bloom"></span>' : '<span class="yolk"></span>');
  for (let i = 0; i < bits; i += 1) {
    const step = kind === "flower" ? 36 : 45;
    parts.push('<i class="' + cls + '" style="--ang:' + (i * step - 12) + "deg;--dist:" + (24 + (i % 3) * 16) + 'px"></i>');
  }
  return parts.join("");
}

function playGesture(from, to, kind, by) {
  const layer = $("gestureLayer");
  const info = GESTURE_KINDS[kind];
  if (!layer || !info) return;
  const start = seatAnchor(from);
  const end = seatAnchor(to);
  const fly = document.createElement("div");
  fly.className = "gesture-fly gesture-fly-" + kind;
  fly.style.setProperty("--sx", start.x + "px");
  fly.style.setProperty("--sy", start.y + "px");
  fly.style.setProperty("--dx", (end.x - start.x) + "px");
  fly.style.setProperty("--dy", (end.y - start.y) + "px");
  fly.innerHTML = info.fly;
  layer.append(fly);
  setTimeout(() => fly.remove(), 720);

  setTimeout(() => {
    const burst = document.createElement("div");
    burst.className = "gesture-burst gesture-burst-" + kind;
    burst.style.left = end.x + "px";
    burst.style.top = end.y + "px";
    burst.innerHTML = burstHtml(kind);
    const who = [by, state?.seats?.[to]?.name].filter(Boolean).join(" \u2192 ");
    if (who) {
      const cap = document.createElement("span");
      cap.className = "gesture-cap";
      cap.textContent = who;
      burst.append(cap);
    }
    layer.append(burst);
    setTimeout(() => burst.remove(), 1500);
    const seatNode = document.querySelector('.seat[data-seat="' + to + '"]');
    if (seatNode && seatNode.offsetParent) {
      seatNode.classList.add("gesture-hit");
      setTimeout(() => seatNode.classList.remove("gesture-hit"), 950);
    }
  }, 620);
}

function closeGesturePop() {
  gesturePopSeat = -1;
  $("gesturePop").classList.add("hidden");
}

function openGesturePop(seat, anchorEl) {
  const pop = $("gesturePop");
  if (!pop || seat < 0 || seat === you) return;
  if (gesturePopSeat === seat) {
    closeGesturePop();
    return;
  }
  gesturePopSeat = seat;
  pop.innerHTML = "";
  for (const kind of Object.keys(GESTURE_KINDS)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gesture-btn";
    btn.innerHTML = GESTURE_KINDS[kind].icon;
    const label = document.createElement("span");
    label.textContent = GESTURE_KINDS[kind].label;
    btn.append(label);
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      socket.emit("gesture", { seat, kind });
      closeGesturePop();
    });
    pop.append(btn);
  }
  pop.classList.remove("hidden");
  const box = anchorEl.getBoundingClientRect();
  const size = pop.getBoundingClientRect();
  let left = box.left + box.width / 2 - size.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - size.width - 8));
  let top = box.bottom + 8;
  if (top + size.height > window.innerHeight - 8) top = Math.max(8, box.top - size.height - 8);
  pop.style.left = Math.round(left) + "px";
  pop.style.top = Math.round(top) + "px";
}

const FX_INFO = {
  straight: { text: "\u987a\u5b50", shake: 0, flash: false },
  pairseq: { text: "\u6728\u677f", shake: 0, flash: false },
  tripleseq: { text: "\u94a2\u677f", shake: 1, flash: false },
  bomb: { text: "\u70b8\u5f39", shake: 2, flash: true },
  flushstraight: { text: "\u540c\u82b1\u987a", shake: 2, flash: true },
  jokerbomb: { text: "\u5929\u738b\u70b8", shake: 3, flash: true }
};
const FX_GROUP = { pairseq: 2, tripleseq: 3 };

function trickKeyOf(match) {
  const play = match?.lastPlay;
  const combo = play?.combo;
  if (!combo) return "";
  return [match.round, play.seat, combo.type, combo.cards.map((card) => card.id).join(",")].join("|");
}

function shakeBoard(level) {
  const board = document.querySelector(".board");
  const felt = document.querySelector(".felt");
  if (!board || !level) return;
  const cls = "shake-" + Math.min(3, level);
  board.classList.remove("shake-1", "shake-2", "shake-3");
  void board.offsetWidth;
  board.classList.add(cls);
  if (felt) felt.classList.add("no-scroll");
  clearTimeout(shakeTimer);
  shakeTimer = setTimeout(() => {
    board.classList.remove(cls);
    if (felt) felt.classList.remove("no-scroll");
  }, 950);
}

function playComboFx(combo, seat) {
  const info = FX_INFO[combo.type];
  const layer = $("fx");
  if (!info || !layer) return;
  if (info.flash) {
    const flash = document.createElement("div");
    flash.className = "fx-flash fx-flash-" + combo.type;
    layer.append(flash);
    setTimeout(() => flash.remove(), 850);
  }
  const shout = document.createElement("div");
  shout.className = "fx-shout fx-shout-" + combo.type;
  const text = combo.type === "bomb" && combo.cards.length > 4
    ? combo.cards.length + "\u5f20" + info.text
    : info.text;
  shout.textContent = text + "\uff01";
  const name = state?.match?.names?.[seat];
  if (name) {
    const who = document.createElement("small");
    who.textContent = name;
    shout.append(who);
  }
  layer.append(shout);
  setTimeout(() => shout.remove(), 1700);
  shakeBoard(info.shake);
}

/* ---------------- table cards are re-sorted into rank order ---------------- */
function comboValue(card, levelRank) {
  if (card.rank === 17) return 18;
  if (card.rank === 16) return 17;
  if (card.rank === levelRank) return 16;
  if (card.rank === 15) return 2;
  return card.rank;
}

function runLength(combo) {
  if (combo.run) return combo.run;
  if (combo.type === "pairseq") return 3;
  if (combo.type === "tripleseq") return 2;
  return 5;
}

// The engine axis for runs: 1 = A low, 2 = the plain 2, 3..14 natural.
function posRank(position) {
  if (position === 1) return 14;
  if (position === 2) return 15;
  return position;
}

function sortRun(combo, cards, levelRank) {
  const len = runLength(combo);
  const copies = combo.type === "tripleseq" ? 3 : combo.type === "pairseq" ? 2 : 1;
  const top = combo.rank;
  const isWild = (card) => card.suit === "H" && card.rank === levelRank;
  const naturals = cards.filter((card) => !isWild(card));
  const wilds = cards.filter(isWild);
  const slot = new Map();
  let wildAt = 0;
  for (let offset = 0; offset < len; offset += 1) {
    const rank = posRank(top - len + 1 + offset);
    const here = naturals.filter((card) => card.rank === rank);
    for (const card of here) slot.set(card.id, offset);
    for (let copy = here.length; copy < copies; copy += 1) {
      const wild = wilds[wildAt];
      if (!wild) break;
      slot.set(wild.id, offset + 0.5);
      wildAt += 1;
    }
  }
  for (const card of cards) if (!slot.has(card.id)) slot.set(card.id, len + 1);
  return cards.slice().sort((a, b) => slot.get(a.id) - slot.get(b.id) || String(a.suit).localeCompare(String(b.suit)));
}

function wildRepresentations(combo, cards, levelRank) {
  const reps = new Map();
  const isWild = (card) => card.suit === "H" && card.rank === levelRank;
  const wilds = cards.filter(isWild);
  if (!wilds.length) return reps;
  const mark = (card, rank) => reps.set(card.id, rank);

  if (["single", "pair", "triple", "bomb"].includes(combo.type)) {
    for (const card of wilds) mark(card, combo.rank);
    return reps;
  }

  if (combo.type === "fullhouse") {
    let tripleSlots = 3;
    let pairSlots = 2;
    const fillExact = (rank, slots) => {
      for (const card of cards) {
        if (slots <= 0) break;
        if (isWild(card) || card.rank !== rank) continue;
        slots -= 1;
      }
      for (const card of wilds) {
        if (slots <= 0) break;
        if (card.rank !== rank || reps.has(card.id)) continue;
        mark(card, rank);
        slots -= 1;
      }
      return slots;
    };
    tripleSlots = fillExact(combo.rank, tripleSlots);
    pairSlots = fillExact(combo.pairRank, pairSlots);
    for (const card of wilds) {
      if (reps.has(card.id)) continue;
      if (tripleSlots > 0) {
        mark(card, combo.rank);
        tripleSlots -= 1;
      } else if (pairSlots > 0) {
        mark(card, combo.pairRank);
        pairSlots -= 1;
      } else {
        mark(card, combo.rank);
      }
    }
    return reps;
  }

  if (["straight", "pairseq", "tripleseq", "flushstraight"].includes(combo.type)) {
    const len = runLength(combo);
    const copies = combo.type === "tripleseq" ? 3 : combo.type === "pairseq" ? 2 : 1;
    const start = combo.start || combo.rank - len + 1;
    const slots = [];
    for (let offset = 0; offset < len; offset += 1) {
      const rank = posRank(start + offset);
      for (let copy = 0; copy < copies; copy += 1) slots.push(rank);
    }
    const used = new Set();
    for (const rank of slots) {
      const natural = cards.find((card) => !used.has(card.id) && !isWild(card) && card.rank === rank);
      if (natural) used.add(natural.id);
    }
    for (const rank of slots) {
      const exactWild = wilds.find((card) => !used.has(card.id) && card.rank === rank);
      if (!exactWild) continue;
      used.add(exactWild.id);
      mark(exactWild, rank);
    }
    for (const rank of slots) {
      const wild = wilds.find((card) => !used.has(card.id));
      if (!wild) break;
      used.add(wild.id);
      mark(wild, rank);
    }
    for (const card of wilds) if (!reps.has(card.id)) mark(card, combo.rank);
    return reps;
  }

  for (const card of wilds) mark(card, combo.rank);
  return reps;
}

function sortComboCards(combo, levelRank) {
  const cards = combo.cards ?? [];
  if (["straight", "pairseq", "tripleseq", "flushstraight"].includes(combo.type)) {
    return sortRun(combo, cards, levelRank);
  }
  const byValue = (a, b) => comboValue(a, levelRank) - comboValue(b, levelRank) ||
    String(a.suit).localeCompare(String(b.suit));
  if (combo.type === "fullhouse") {
    const same = cards.filter((card) => card.rank === combo.rank);
    const wilds = cards.filter((card) => card.suit === "H" && card.rank === levelRank && card.rank !== combo.rank);
    const triple = (same.length >= 3 ? same : [...same, ...wilds]).slice(0, 3);
    const rest = cards.filter((card) => !triple.includes(card));
    return [...triple.sort(byValue), ...rest.sort(byValue)];
  }
  if (combo.type === "bomb") {
    const same = cards.filter((card) => card.rank === combo.rank);
    const rest = cards.filter((card) => card.rank !== combo.rank);
    return [...same.sort(byValue), ...rest.sort(byValue)];
  }
  return cards.slice().sort(byValue);
}

function renderTrick(match) {
  const trick = $("trick");
  const combo = match?.lastPlay?.combo;
  const key = trickKeyOf(match);
  if (!combo) {
    trickKey = key;
    trick.className = "trick";
    trick.innerHTML = "";
    return;
  }
  if (key === trickKey) return;
  trickKey = key;
  trick.className = "trick fx-" + combo.type;
  trick.innerHTML = "";
  const group = FX_GROUP[combo.type] ?? 1;
  const cards = sortComboCards(combo, match.levelRank);
  const represented = wildRepresentations(combo, cards, match.levelRank);
  cards.forEach((card, index) => {
    const node = renderCard(card, match.levelRank, represented.get(card.id));
    node.style.setProperty("--i", String(index));
    node.style.setProperty("--g", String(Math.floor(index / group)));
    trick.append(node);
  });
  playComboFx(combo, match.lastPlay.seat);
  playComboSound(combo);
}

function renderClock(room) {
  const el = $("clock");
  const match = room?.match;
  const myTurn = Boolean(match && you === match.turn && (match.phase === "play" || match.phase === "returnTribute"));
  if (!myTurn || !room.turnEndsAt) {
    el.classList.add("hidden");
    return;
  }
  const left = Math.max(0, Math.ceil((room.turnEndsAt - Date.now()) / 1000));
  el.textContent = left + "s";
  el.classList.toggle("urgent", left <= 5);
  el.classList.remove("hidden");
}

function isMyTurn(room) {
  const match = room?.match;
  return Boolean(match && room.you === match.turn && (match.phase === "play" || match.phase === "returnTribute"));
}

function stateKey(room) {
  const match = room?.match;
  if (!match) return String(room?.code || "") + ":wait";
  return [
    match.phase,
    match.turn,
    (match.tributeSummary ?? []).length,
    match.log?.at(-1) || "",
    (match.handsCount || []).join("-"),
    match.lastPlay?.combo?.label || "",
    match.current?.label || ""
  ].join("|");
}

function announceTurn(room) {
  const mine = isMyTurn(room);
  if (mine && !myTurnSeen) playTurnChime();
  myTurnSeen = mine;
}

function enqueueState(room) {
  announceTurn(room);
  const tail = stateQueue.at(-1) || displayed;
  if (tail && stateKey(tail) === stateKey(room)) {
    if (stateQueue.length) stateQueue[stateQueue.length - 1] = room;
    else {
      displayed = room;
      render(room);
    }
    return;
  }
  stateQueue.push(room);
  pumpStates();
}

function pumpStates() {
  if (pumping || !stateQueue.length) return;
  const next = stateQueue[0];
  const prev = displayed;
  let wait = 0;
  if (prev && !isMyTurn(prev)) wait = Math.max(0, REVEAL_MS - (Date.now() - lastRevealAt));
  pumping = true;
  const epoch = renderEpoch;
  const go = () => {
    if (epoch !== renderEpoch) {
      pumping = false;
      return;
    }
    stateQueue.shift();
    displayed = next;
    lastRevealAt = Date.now();
    render(next);
    pumping = false;
    pumpStates();
  };
  if (wait <= 80) go();
  else setTimeout(go, wait);
}

function render(room) {
  state = room;
  you = room.you;
  pendingReconnect = false;
  if (room.you >= 0) saveSession(room.code, room.seats[room.you]?.name ?? "");
  $("lobby").classList.add("hidden");
  $("table").classList.remove("hidden");
  $("roomCode").textContent = room.code;
  const match = room.match;
  if (match) {
    const mine = you >= 0 ? you % 2 : 0;
    $("levelLine").textContent = "\u7b2c" + match.round + "\u5c40 \u00b7 \u6253" + match.levelLabel + " \u00b7 \u6211\u65b9" + match.teamLevel[mine] + " \u5bf9\u5bb6" + match.teamLevel[1 - mine];
  } else {
    $("levelLine").textContent = "\u7b49\u5f85\u5f00\u5c40";
  }
  $("banner").textContent = bannerText(room);
  renderNotice(match);
    $("startBtn").classList.toggle("hidden", Boolean(match) && match.phase !== "matchOver");
  $("nextBtn").classList.toggle("hidden", match?.phase !== "roundOver");
  $("botBtn").classList.toggle("hidden", Boolean(match) && match.phase !== "matchOver");
  spectatingNow = updateSpectate(match);
  const myTurn = Boolean(match && you === match.turn && (match.phase === "play" || match.phase === "returnTribute"));
  const canAct = myTurn && !spectatingNow;
  $("playBtn").textContent = match?.phase === "returnTribute" ? "\u8fd8\u8d21" : "\u51fa\u724c";
  $("playBtn").disabled = !canAct;
  $("passBtn").disabled = !(match && canAct && match.phase === "play" && match.current);
  $("hintBtn").disabled = !canAct;
  $("groupBtn").disabled = spectatingNow;
  renderSeats(room);
  renderSelf(room);
  renderTrick(match);
  const ids = new Set(effectiveHand(match).map((card) => card.id));
  for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
  renderHand(match);
  renderCounter(match);
  renderClock(room);
  renderDifficulty(room);
}

function renderNotice(match) {
  const el = $("notice");
  if (!el) return;
  const lines = (match?.tributeSummary ?? []).slice(-3);
  el.textContent = "";
  if (!lines.length) {
    el.classList.add("hidden");
    return;
  }
  for (const line of lines) {
    const span = document.createElement("span");
    span.textContent = line;
    el.append(span);
  }
  if (match.phase === "returnTribute" && match.turn === you) {
    const tip = document.createElement("span");
    tip.className = "notice-tip";
    tip.textContent = hasModestReturnCard(effectiveHand(match), match.levelRank)
      ? "还贡只能选2至10且不是当前级牌的牌"
      : "手里没有2至10的牌，将自动还最小牌";
    el.append(tip);
  }
  el.classList.remove("hidden");
}

function bannerText(room) {
  const match = room.match;
  if (!match) return "\u70b9\u7a7a\u4f4d\u53ef\u6362\u5ea7 \u00b7 \u6ee14\u4eba\u540e\u5f00\u5c40";
  if (match.phase === "matchOver") {
    if (you < 0) return (match.winnerTeam === 0 ? "\u7ea2\u961f" : "\u84dd\u961f") + " \u8fc7A\u80dc\u51fa";
    return match.winnerTeam === you % 2 ? "\u6211\u65b9\u8fc7A\u80dc\u51fa" : "\u5bf9\u5bb6\u8fc7A\u80dc\u51fa";
  }
  if (match.phase === "roundOver") return match.roundResult?.kind ?? "\u672c\u5c40\u7ed3\u675f";
  if (match.phase === "returnTribute") {
    return match.turn === you ? "\u8f6e\u5230\u4f60\u8fd8\u8d21" : match.names[match.turn] + " \u8fd8\u8d21";
  }
  if (match.current) return match.names[match.lastPlay.seat] + " \u51fa\u4e86 " + match.current.label;
  return match.names[match.turn] + " \u51fa\u724c";
}

function resetToLobby(message) {
  renderEpoch += 1;
  stateQueue = [];
  pumping = false;
  displayed = null;
  state = null;
  you = -1;
  myTurnSeen = false;
  selected.clear();
  closeComboChoice();
  handPiles = [];
  handPilesCustom = false;
  handOwner = null;
  pilesByOwner.clear();
  spectateOn = false;
  spectatingNow = false;
  trickKey = "";
  const trick = $("trick");
  trick.className = "trick";
  trick.innerHTML = "";
  $("hand").innerHTML = "";
  $("fx").innerHTML = "";
  $("gestureLayer").innerHTML = "";
  closeGesturePop();
  $("clock").classList.add("hidden");
  $("notice").classList.add("hidden");
  $("counter").classList.add("hidden");
  $("counterBtn").classList.add("hidden");
  $("spectateBtn").classList.add("hidden");
  $("spectateBtn").classList.remove("on");
  document.querySelector(".hand-wrap")?.classList.remove("spectating");
  $("table").classList.add("hidden");
  $("lobby").classList.remove("hidden");
  $("lobbyError").textContent = message || "";
}

bindHandDrag();
clockTimer = setInterval(() => {
  if (state) renderClock(state);
}, 250);

function currentName() {
  const name = $("name").value.trim() || "\u73a9\u5bb6";
  localStorage.setItem("guandan-name", name);
  return name;
}

$("createBtn").addEventListener("click", () => {
  clearSession();
  socket.emit("create", { name: currentName(), token: deviceToken() });
});
$("joinBtn").addEventListener("click", () => {
  pendingReconnect = false;
  socket.emit("join", { name: currentName(), code: $("code").value, token: deviceToken() });
});
$("leaveBtn").addEventListener("click", () => {
  socket.emit("leave");
  clearSession();
  pendingReconnect = false;
  resetToLobby();
  toast("\u5df2\u9000\u51fa\u724c\u684c");
});
$("zoomInBtn").addEventListener("click", () => setZoom(zoom + ZOOM_STEP));
$("zoomOutBtn").addEventListener("click", () => setZoom(zoom - ZOOM_STEP));
$("soundBtn").addEventListener("click", () => {
  soundOn = !soundOn;
  localStorage.setItem(SOUND_KEY, soundOn ? "on" : "off");
  applySound();
  if (soundOn) playTurnChime();
});
$("counterBtn").addEventListener("click", () => {
  counterOn = !counterOn;
  localStorage.setItem(COUNTER_KEY, counterOn ? "on" : "off");
  applyCounter();
  if (state) render(state);
});
$("spectateBtn").addEventListener("click", () => {
  spectateOn = !spectateOn;
  selected.clear();
  if (state) render(state);
  if (!state) return;
  if (spectatingNow) {
    const info = spectateInfo(state.match);
    toast("正在看 " + (info?.name ?? "队友") + " 的牌");
  } else {
    toast("已回到自己的视角");
  }
});
document.querySelector(".board").addEventListener("click", (event) => {
  const avatar = event.target.closest(".avatar[data-seat]");
  const holder = event.target.closest(".seat");
  const picking = Boolean(holder && holder.classList.contains("pick"));
  if (avatar && !picking) {
    event.stopPropagation();
    openGesturePop(Number(avatar.dataset.seat), avatar);
    return;
  }
  closeGesturePop();
  const node = event.target.closest(".seat.pick");
  if (!node || state?.match) return;
  socket.emit("sit", { seat: Number(node.dataset.seat) });
});
$("botBtn").addEventListener("click", () => socket.emit("fillBots"));
$("startBtn").addEventListener("click", () => socket.emit("start"));
$("nextBtn").addEventListener("click", () => socket.emit("nextRound"));
$("playBtn").addEventListener("click", () => {
  const cardIds = [...selected];
  if (state?.match?.phase === "returnTribute") socket.emit("returnTribute", { cardId: cardIds[0] });
  else socket.emit("play", { cardIds });
});
$("passBtn").addEventListener("click", () => socket.emit("pass"));
$("groupBtn").addEventListener("click", groupSelected);
$("hintBtn").addEventListener("click", () => socket.emit("hint"));
$("comboChoiceClose").addEventListener("click", closeComboChoice);

/* ---------------- appearance panel and bot strength ---------------- */
const DIFF_LEVELS = ["easy", "medium", "hard"];

function renderDifficulty(room) {
  const group = $("diffGroup");
  if (!group) return;
  const match = room?.match;
  const live = Boolean(match && match.phase !== "matchOver");
  group.classList.toggle("hidden", live);
  const level = DIFF_LEVELS.includes(room?.difficulty) ? room.difficulty : "hard";
  const host = Boolean(room?.youHost);
  for (const btn of group.querySelectorAll(".seg")) {
    const on = btn.dataset.diff === level;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.disabled = !host || live;
  }
}

function previewFace(suit, rank, red) {
  return '<span class="card opt-card' + (red ? " red" : "") + '">' +
    '<span class="corner"><strong>' + rank + "</strong><small>" + suit + "</small></span>" +
    '<span class="pip">' + suit + "</span></span>";
}

function buildSettings() {
  const skinRow = $("cardSkins");
  const feltRow = $("feltColors");
  if (!skinRow || !feltRow) return;
  skinRow.textContent = "";
  feltRow.textContent = "";
  for (const skin of CARD_SKINS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "opt";
    btn.dataset.skin = skin.id;
    btn.dataset.cardSkin = skin.id;
    btn.title = skin.name;
    btn.innerHTML = '<span class="opt-face">' + previewFace(SUIT.S, "A", false) + previewFace(SUIT.H, "A", true) +
      "</span><span>" + skin.name + "</span>";
    btn.addEventListener("click", () => setCardSkin(skin.id));
    skinRow.appendChild(btn);
  }
  for (const felt of FELTS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "opt";
    btn.dataset.felt = felt.id;
    btn.title = felt.name;
    btn.innerHTML = '<span class="opt-felt" data-felt="' + felt.id + '"></span><span>' + felt.name + "</span>";
    btn.addEventListener("click", () => setFelt(felt.id));
    feltRow.appendChild(btn);
  }
  applyAppearance();
}

function closeSettings() {
  $("settingsPanel").classList.add("hidden");
}

function openSettings() {
  closeGesturePop();
  $("settingsPanel").classList.remove("hidden");
}

$("settingsBtn").addEventListener("click", openSettings);
$("lobbySettingsBtn").addEventListener("click", openSettings);
$("settingsClose").addEventListener("click", closeSettings);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeSettings();
  closeGesturePop();
  closeComboChoice();
});
document.addEventListener("click", (event) => {
  if (event.target.closest("#settingsPanel, #settingsBtn, #lobbySettingsBtn")) return;
  closeSettings();
});
for (const btn of document.querySelectorAll("#diffGroup .seg")) {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    socket.emit("setDifficulty", { level: btn.dataset.diff });
  });
}
buildSettings();

function rejoinSavedRoom() {
  const session = readSession();
  if (!session) return;
  pendingReconnect = true;
  socket.emit("join", { name: session.name || currentName(), code: session.code, token: deviceToken() });
}

socket.on("connect", rejoinSavedRoom);
if (socket.connected) rejoinSavedRoom();
socket.on("state", enqueueState);
socket.on("errorMessage", (text) => {
  if (pendingReconnect) {
    pendingReconnect = false;
    clearSession();
    resetToLobby(text);
    $("code").value = "";
    toast(text === "\u623f\u95f4\u4e0d\u5b58\u5728" ? "\u539f\u724c\u684c\u5df2\u6563\u573a" : text);
    return;
  }
  $("lobbyError").textContent = text;
  toast(text);
});
socket.on("hint", ({ cardIds, action, reason, index, total }) => {
  if (action === "pass") {
    return toast(reason || "\u6ca1\u6709\u80fd\u538b\u7684\u724c\uff0c\u53ef\u4ee5\u4e0d\u8981");
  }
  selected.clear();
  for (const id of cardIds ?? []) selected.add(id);
  if (state) render(state);
  if (reason) toast(total > 1 ? reason + " (" + index + "/" + total + ")" : reason);
});

document.addEventListener("click", (event) => {
  if (event.target.closest("#gesturePop")) return;
  closeGesturePop();
});
window.addEventListener("resize", closeGesturePop);
window.addEventListener("scroll", closeGesturePop, true);
socket.on("gesture", ({ from, to, kind, by } = {}) => playGesture(from, to, kind, by));
socket.on("comboChoice", openComboChoice);
