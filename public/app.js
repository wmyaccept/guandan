const socket = io();
const $ = (id) => document.getElementById(id);
const selected = new Set();
let state = null;
let you = -1;
let handPiles = [];
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

const savedSession = readSession();
if (savedSession) $("code").value = savedSession.code;
applyZoom();
applySound();
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

function renderCard(card, levelRank) {
  const div = document.createElement("button");
  div.type = "button";
  div.className = cardClass(card, levelRank);
  div.dataset.id = card.id;
  const rank = RANK[card.rank];
  const suit = SUIT[card.suit] ?? "";
  const wild = card.suit === "H" && card.rank === levelRank;
  div.innerHTML = '<span class="corner"><strong>' + rank + '</strong><small>' + suit + '</small></span>' + (wild ? '<span class="wild-mark">配</span>' : '');
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
  if (state) renderHand(state.match);
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
    node.innerHTML = "<b>" + (person?.name ?? "\u7a7a\u4f4d") + "</b><span>" + (bits.join(" \u00b7 ") || " ") + "</span>";
  });
}

function renderSelf(room) {
  const el = $("selfStatus");
  if (!el) return;
  const seat = you >= 0 ? you : 0;
  const person = room.seats[seat];
  const match = room.match;
  const remain = remainLabel(match?.handsCount?.[seat] ?? 0);
  el.innerHTML = "<b>" + (person?.name ?? "") + "</b>" + (remain ? "<span>" + remain + "</span>" : "");
  el.classList.toggle("turn", Boolean(match && you === match.turn && (match.phase === "play" || match.phase === "returnTribute")));
}

function toggleSelect(id, node) {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  node.classList.toggle("up", selected.has(id));
}

function renderHand(match) {
  const hand = $("hand");
  hand.innerHTML = "";
  if (!match) {
    handPiles = [];
    return;
  }
  const cards = match.hand ?? [];
  syncPiles(cards);
  const byId = new Map(cards.map((card) => [card.id, card]));
  handPiles.forEach((pile, index) => {
    const col = document.createElement("div");
    col.className = "pile";
    col.dataset.index = String(index);
    for (const id of pile) {
      const card = byId.get(id);
      if (!card) continue;
      const node = renderCard(card, match.levelRank);
      if (selected.has(card.id)) node.classList.add("up");
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
  combo.cards.forEach((card, index) => {
    const node = renderCard(card, match.levelRank);
    node.style.setProperty("--i", String(index));
    node.style.setProperty("--g", String(Math.floor(index / group)));
    trick.append(node);
  });
  playComboFx(combo, match.lastPlay.seat);
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
  const myTurn = Boolean(match && you === match.turn && (match.phase === "play" || match.phase === "returnTribute"));
  $("playBtn").textContent = match?.phase === "returnTribute" ? "\u8fd8\u8d21" : "\u51fa\u724c";
  $("playBtn").disabled = !myTurn;
  $("passBtn").disabled = !(match && myTurn && match.phase === "play" && match.current);
  $("hintBtn").disabled = !myTurn;
  renderSeats(room);
  renderSelf(room);
  renderTrick(match);
  const ids = new Set((match?.hand ?? []).map((card) => card.id));
  for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
  renderHand(match);
  renderClock(room);
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
    tip.textContent = "\u9009\u4e00\u5f20\u724c\u70b9\u201c\u8fd8\u8d21\u201d\uff0c\u4e0d\u9009\u5219\u81ea\u52a8\u8fd8\u5c0f\u724c";
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
  handPiles = [];
  trickKey = "";
  const trick = $("trick");
  trick.className = "trick";
  trick.innerHTML = "";
  $("hand").innerHTML = "";
  $("fx").innerHTML = "";
  $("clock").classList.add("hidden");
  $("notice").classList.add("hidden");
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
document.querySelector(".board").addEventListener("click", (event) => {
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
