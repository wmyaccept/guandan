import { chooseReturnCard, suggestPlays } from "./game/ai.js";
import { autoAct, createMatch, levelRankOf, playCards, passTurn, publicState, returnableCards, returnTribute, startRound } from "./game/engine.js";

const rooms = new Map();
const socketRoom = new Map();
const BOT_DELAY_MS = 2800;
const TURN_LIMIT_MS = 30000;

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return rooms.has(code) ? randomCode() : code;
}

function getRoom(code) {
  return rooms.get(String(code || "").trim().toUpperCase());
}

function serializeRoom(room, socketId) {
  const seat = room.seats.findIndex((item) => item?.socketId === socketId);
  return {
    code: room.code,
    seats: room.seats.map((item) =>
      item
        ? {
            name: item.name,
            bot: item.bot,
            connected: item.bot || Boolean(item.socketId)
          }
        : null
    ),
    hostId: room.hostId,
    match: room.match ? publicState(room.match, seat >= 0 ? seat : null) : null,
    you: seat,
    turnEndsAt: room.turnEndsAt ?? null
  };
}

function broadcast(io, room) {
  for (const [id, socket] of io.sockets.sockets) {
    if (socketRoom.get(id) !== room.code) continue;
    socket.emit("state", serializeRoom(room, id));
  }
}

function namesOf(room) {
  return room.seats.map((seat, index) => seat?.name ?? "\u7a7a\u4f4d" + (index + 1));
}

function botsOf(room) {
  return room.seats.map((seat) => Boolean(seat?.bot));
}

function filled(room) {
  return room.seats.every(Boolean);
}

function currentActor(match) {
  if (!match) return null;
  if (match.phase === "returnTribute") return match.returnsPlan[0]?.from ?? null;
  if (match.phase === "play") return match.turn;
  return null;
}

function clearRoomTimers(room) {
  if (room.botTimer) clearTimeout(room.botTimer);
  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.botTimer = null;
  room.turnTimer = null;
  room.turnEndsAt = null;
}

function nextToken(room) {
  room.actionToken = (room.actionToken || 0) + 1;
  return room.actionToken;
}

function scheduleAfterAction(io, room, delayMs = 0) {
  clearRoomTimers(room);
  broadcast(io, room);
  const match = room.match;
  const seat = currentActor(match);
  if (seat == null) return;
  const token = nextToken(room);
  if (room.seats[seat]?.bot) {
    const wait = Math.max(delayMs, BOT_DELAY_MS);
    room.botTimer = setTimeout(() => {
      if (room.actionToken !== token) return;
      if (!room.match || currentActor(room.match) !== seat) return;
      const result = autoAct(room.match, seat);
      if (result?.ok) scheduleAfterAction(io, room, BOT_DELAY_MS);
      else broadcast(io, room);
    }, wait);
    return;
  }
  room.turnEndsAt = Date.now() + TURN_LIMIT_MS;
  broadcast(io, room);
  room.turnTimer = setTimeout(() => {
    if (room.actionToken !== token) return;
    if (!room.match || currentActor(room.match) !== seat) return;
    const result = autoAct(room.match, seat);
    if (result?.ok) scheduleAfterAction(io, room, BOT_DELAY_MS);
    else broadcast(io, room);
  }, TURN_LIMIT_MS);
}

export function attachSockets(io) {
  io.on("connection", (socket) => {
    socket.on("create", ({ name }) => {
      const code = randomCode();
      const room = {
        code,
        hostId: socket.id,
        seats: [null, null, null, null],
        match: null,
        actionToken: 0
      };
      room.seats[0] = { name: String(name || "\u73a9\u5bb6").slice(0, 12), socketId: socket.id, bot: false };
      rooms.set(code, room);
      socketRoom.set(socket.id, code);
      socket.join(code);
      broadcast(io, room);
    });

    socket.on("join", ({ name, code }) => {
      const room = getRoom(code);
      if (!room) return socket.emit("errorMessage", "\u623f\u95f4\u4e0d\u5b58\u5728");
      const existing = room.seats.findIndex((seat) => seat?.name === name && !seat.bot && !seat.socketId);
      const empty = room.seats.findIndex((seat) => !seat);
      const seat = existing >= 0 ? existing : empty;
      if (seat < 0) return socket.emit("errorMessage", "\u623f\u95f4\u5df2\u6ee1");
      room.seats[seat] = {
        name: String(name || "\u73a9\u5bb6" + (seat + 1)).slice(0, 12),
        socketId: socket.id,
        bot: false
      };
      socketRoom.set(socket.id, room.code);
      socket.join(room.code);
      broadcast(io, room);
    });

    socket.on("fillBots", () => {
      const room = getRoom(socketRoom.get(socket.id));
      if (!room) return;
      const botNames = ["\u963f\u5f3a", "\u5c0f\u5468", "\u8001\u674e"];
      let n = 0;
      for (let i = 0; i < 4; i += 1) {
        if (!room.seats[i]) {
          room.seats[i] = { name: botNames[n], socketId: null, bot: true };
          n += 1;
        }
      }
      broadcast(io, room);
    });

    socket.on("start", () => {
      const room = getRoom(socketRoom.get(socket.id));
      if (!room) return;
      if (!filled(room)) return socket.emit("errorMessage", "\u6ee14\u4eba\u624d\u80fd\u5f00\u5c40\uff0c\u7a7a\u4f4d\u53ef\u4ee5\u52a0\u673a\u5668\u4eba");
      room.match = createMatch(namesOf(room), { bots: botsOf(room) });
      startRound(room.match);
      scheduleAfterAction(io, room, BOT_DELAY_MS);
    });

    socket.on("play", ({ cardIds }) => {
      const room = getRoom(socketRoom.get(socket.id));
      if (!room?.match) return;
      const seat = room.seats.findIndex((item) => item?.socketId === socket.id);
      const result = playCards(room.match, seat, cardIds ?? []);
      if (!result.ok) return socket.emit("errorMessage", result.error);
      scheduleAfterAction(io, room, BOT_DELAY_MS);
    });

    socket.on("pass", () => {
      const room = getRoom(socketRoom.get(socket.id));
      if (!room?.match) return;
      const seat = room.seats.findIndex((item) => item?.socketId === socket.id);
      const result = passTurn(room.match, seat);
      if (!result.ok) return socket.emit("errorMessage", result.error);
      scheduleAfterAction(io, room, BOT_DELAY_MS);
    });

    socket.on("returnTribute", ({ cardId }) => {
      const room = getRoom(socketRoom.get(socket.id));
      if (!room?.match) return;
      const seat = room.seats.findIndex((item) => item?.socketId === socket.id);
      const result = returnTribute(room.match, seat, cardId);
      if (!result.ok) return socket.emit("errorMessage", result.error);
      scheduleAfterAction(io, room, BOT_DELAY_MS);
    });

    socket.on("nextRound", () => {
      const room = getRoom(socketRoom.get(socket.id));
      if (!room?.match) return;
      if (room.match.phase !== "roundOver") return;
      startRound(room.match);
      scheduleAfterAction(io, room, BOT_DELAY_MS);
    });

    socket.on("hint", () => {
      const room = getRoom(socketRoom.get(socket.id));
      if (!room?.match) return;
      const seat = room.seats.findIndex((item) => item?.socketId === socket.id);
      if (seat < 0) return;
      const match = room.match;
      if (match.phase === "returnTribute") {
        const step = match.returnsPlan.find((item) => item.from === seat);
        if (!step) return;
        const allowed = returnableCards(match.hands[seat], levelRankOf(match));
        const pick = chooseReturnCard(match.hands[seat], allowed, levelRankOf(match)) ?? allowed[0];
        socket.emit("hint", { cardIds: pick ? [pick.id] : [], action: "return" });
        return;
      }
      if (match.phase !== "play" || match.turn !== seat) return;
      const options = suggestPlays(match, seat, levelRankOf(match));
      if (!options.length) return socket.emit("hint", { cardIds: [], action: "pass" });
      const key = [
        match.round,
        match.turn,
        match.hands[seat].length,
        match.passes,
        (match.current?.cards ?? []).map((card) => card.id).sort().join(",")
      ].join("|");
      if (room.hintKey !== key) {
        room.hintKey = key;
        room.hintIndex = 0;
      }
      const index = room.hintIndex % options.length;
      room.hintIndex = index + 1;
      const pick = options[index];
      socket.emit("hint", {
        cardIds: pick.cardIds,
        action: pick.action,
        reason: pick.reason,
        index: index + 1,
        total: options.length
      });
    });

    socket.on("disconnect", () => {
      const code = socketRoom.get(socket.id);
      socketRoom.delete(socket.id);
      const room = getRoom(code);
      if (!room) return;
      for (const seat of room.seats) {
        if (seat?.socketId === socket.id) seat.socketId = null;
      }
      const alive = room.seats.some((seat) => seat?.socketId);
      if (!alive) {
        clearRoomTimers(room);
        rooms.delete(room.code);
      } else broadcast(io, room);
    });
  });
}
