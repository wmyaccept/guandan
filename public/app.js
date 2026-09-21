const socket = io();
const $ = (id) => document.getElementById(id);
const selected = new Set();
let state = null;
let you = -1;

const RANK = {
  3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10",
  11: "J", 12: "Q", 13: "K", 14: "A", 15: "2", 16: "小王", 17: "大王"
};
const SUIT = { S: "♠", H: "♥", D: "♦", C: "♣", J: "王" };

const savedName = localStorage.getItem("guandan-name") || "";
$("name").value = savedName || `玩家${Math.floor(Math.random() * 90 + 10)}`;

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add("hidden"), 2200);
}

function viewOf(seat) {
  if (you < 0) return seat;
  return (seat - you + 4) % 4;
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
  div.innerHTML = `<small>${SUIT[card.suit] ?? ""}</small><strong>${RANK[card.rank]}</strong>`;
  return div;
}

function renderBack() {
  const div = document.createElement("div");
  div.className = "card back";
  return div;
}

function renderSeats(room) {
  const match = room.match;
  document.querySelectorAll(".seat").forEach((node) => {
    const view = Number(node.dataset.view);
    const seat = you < 0 ? view : (you + view) % 4;
    const person = room.seats[seat];
    const count = match?.handsCount?.[seat] ?? 0;
    const team = seat % 2 === 0 ? "南北" : "东西";
    node.classList.toggle("turn", Boolean(match && match.turn === seat && (match.phase === "play" || match.phase === "returnTribute")));
    node.innerHTML = `
      <b>${person?.name ?? "空位"}</b>
      <span>${team}${person?.bot ? " · 机器人" : ""} · ${count}张</span>
    `;
    if (match?.lastPlays?.[seat]?.cards?.length && view !== 0) {
      const row = document.createElement("div");
      row.className = "mini-cards";
      match.lastPlays[seat].cards.slice(0, 6).forEach((card) => row.append(renderCard(card, match.levelRank)));
      node.append(row);
    }
  });
}

function renderHand(match) {
  const hand = $("hand");
  hand.innerHTML = "";
  if (!match) return;
  for (const card of match.hand ?? []) {
    const node = renderCard(card, match.levelRank);
    if (selected.has(card.id)) node.classList.add("up");
    node.addEventListener("click", () => {
      if (selected.has(card.id)) selected.delete(card.id);
      else selected.add(card.id);
      node.classList.toggle("up");
    });
    hand.append(node);
  }
}

function renderTrick(match) {
  const trick = $("trick");
  trick.innerHTML = "";
  const combo = match?.lastPlay?.combo;
  if (!combo) return;
  for (const card of combo.cards) trick.append(renderCard(card, match.levelRank));
}

function render(room) {
  state = room;
  you = room.you;
  $("lobby").classList.add("hidden");
  $("table").classList.remove("hidden");
  $("roomCode").textContent = room.code;
  const match = room.match;
  $("levelLine").textContent = match
    ? `第${match.round}局 · 打${match.levelLabel} · 南北${match.teamLevel[0]} 东西${match.teamLevel[1]}`
    : "等待开局";
  $("banner").textContent = bannerText(room);
  $("log").innerHTML = (match?.log ?? []).map((line) => `<div>${line}</div>`).join("");
  $("startBtn").classList.toggle("hidden", Boolean(match) && match.phase !== "matchOver");
  $("nextBtn").classList.toggle("hidden", match?.phase !== "roundOver");
  $("botBtn").classList.toggle("hidden", Boolean(match) && match.phase !== "matchOver");
  const myTurn = Boolean(match && you === match.turn && (match.phase === "play" || match.phase === "returnTribute"));
  $("playBtn").textContent = match?.phase === "returnTribute" ? "还贡" : "出牌";
  $("playBtn").disabled = !myTurn;
  $("passBtn").disabled = !(match && myTurn && match.phase === "play" && match.current);
  $("hintBtn").disabled = !myTurn;
  renderSeats(room);
  renderTrick(match);
  const ids = new Set((match?.hand ?? []).map((card) => card.id));
  for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
  renderHand(match);
}

function bannerText(room) {
  const match = room.match;
  if (!match) return "满4人后开局，空位可补机器人";
  if (match.phase === "matchOver") return `${match.winnerTeam === 0 ? "南北" : "东西"} 过A胜出`;
  if (match.phase === "roundOver") return `${match.roundResult?.kind ?? "本局结束"}`;
  if (match.phase === "returnTribute") return `${match.names[match.turn]} 还贡`;
  if (match.current) return `${match.names[match.lastPlay.seat]} 出了 ${match.current.label}`;
  return `${match.names[match.turn]} 出牌`;
}

$("createBtn").addEventListener("click", () => {
  const name = $("name").value.trim() || "玩家";
  localStorage.setItem("guandan-name", name);
  socket.emit("create", { name });
});
$("joinBtn").addEventListener("click", () => {
  const name = $("name").value.trim() || "玩家";
  localStorage.setItem("guandan-name", name);
  socket.emit("join", { name, code: $("code").value });
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
$("hintBtn").addEventListener("click", () => socket.emit("hint"));

socket.on("state", render);
socket.on("errorMessage", (text) => {
  $("lobbyError").textContent = text;
  toast(text);
});
socket.on("hint", ({ cardIds, action }) => {
  if (action === "pass") return toast("没有能压的牌，可以不要");
  selected.clear();
  for (const id of cardIds ?? []) selected.add(id);
  if (state) render(state);
});
