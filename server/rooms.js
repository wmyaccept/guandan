import { chooseReturnCard, suggestPlays } from "./game/ai.js";
import { autoAct, createMatch, levelRankOf, playCards, passTurn, publicState, returnableCards, returnTribute, startRound } from "./game/engine.js";

const rooms = new Map();
const socketRoom = new Map();
const BOT_DELAY_MS = 2800;
const TURN_LIMIT_MS = 30000;
const ROOM_GRACE_MS = 10 * 60 * 1000;

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return rooms.has(code) ? randomCode() : code;
}

function getRoom(code) {
  return rooms.get(String(code || "").trim().toUpperCase());
}

// A refresh can reconnect before the server notices the old transport died,
// so a seat still held by an unknown socket counts as reclaimable.
function isLive(io, socketId) {
  if (!socketId) return false;
  const pool = io && io.sockets && io.sockets.sockets;
  if (!pool) return false;
  return typeof pool.has === "function" ? pool.has(socketId) : Boolean(pool[socketId]);
}

function clientToken(token) {
  return typeof token === "string" && token.length >= 8 && token.length <= 64 ? token : null;
}

// The previous holder can still look connected after a crash or a mobile tab
// kill, so drop it to hand the seat back to the returning player.
function dropStaleSocket(io, prev, keepId) {
  const stale = prev && prev.socketId;
  if (!stale || stale === keepId) return;
  socketRoom.delete(stale);
  const pool = io && io.sockets && io.sockets.sockets;
  const old = pool && typeof pool.get === "function" ? pool.get(stale) : null;
  if (old && typeof old.disconnect === "function") old.disconnect(true);
}

function seatView(item) {
  if (!item) return null;
  return {
    name: item.name,
    bot: item.bot,
    hosted: Boolean(item.hosted),
    connected: item.bot || Boolean(item.socketId)
  };
}

function serializeRoom(room, socketId) {
  const seat = room.seats.findIndex((item) => item?.socketId === socketId);
  return {
    code: room.code,
    seats: room.seats.map(seatView),
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

function cancelRoomCleanup(room) {
  if (room.graceTimer) clearTimeout(room.graceTimer);
  room.graceTimer = null;
}

function scheduleRoomCleanup(room) {
  cancelRoomCleanup(room);
  room.graceTimer = setTimeout(() => {
    room.graceTimer = null;
    if (room.seats.some((seat) => seat?.socketId)) return;
    clearRoomTimers(room);
    rooms.delete(room.code);
  }, ROOM_GRACE_MS);
}

function resumeIfIdle(io, room) {
  if (!room.match || room.botTimer || room.turnTimer) return;
  if (currentActor(room.match) == null) return;
  scheduleAfterAction(io, room, BOT_DELAY_MS);
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
    socket.on("create", ({ name, token } = {}) => {
      const code = randomCode();
      const room = {
        code,
        hostId: socket.id,
        seats: [null, null, null, null],
        match: null,
        actionToken: 0,
        graceTimer: null
      };
      room.seats[0] = {
        name: String(name || "\u73a9\u5bb6").slice(0, 12),
        socketId: socket.id,
        bot: false,
        token: clientToken(token)
      };
      rooms.set(code, room);
      socketRoom.set(socket.id, code);
      socket.join(code);
      broadcast(io, room);
    });

    socket.on("join", ({ name, code, token } = {}) => {
      const room = getRoom(code);
      if (!room) return socket.emit("errorMessage", "\u623f\u95f4\u4e0d\u5b58\u5728");
      cancelRoomCleanup(room);
      const wanted = String(name || "").slice(0, 12);
      const mine = clientToken(token);
      const byToken = mine ? room.seats.findIndex((seat) => seat && seat.token === mine) : -1;
      const byName = room.seats.findIndex(
        (seat) =>
          seat &&
          seat.name === wanted &&
          (seat.hosted || !seat.bot) &&
          !isLive(io, seat.socketId)
      );
      const empty = room.seats.findIndex((seat) => !seat);
      const seat = byToken >= 0 ? byToken : byName >= 0 ? byName : empty;
      if (seat < 0) return socket.emit("errorMessage", "\u623f\u95f4\u5df2\u6ee1");
      const prev = room.seats[seat];
      room.seats[seat] = {
        name: String(name || "\u73a9\u5bb6" + (seat + 1)).slice(0, 12),
        socketId: socket.id,
        bot: false,
        hosted: false,
        token: mine || prev?.token || null
      };
      dropStaleSocket(io, prev, socket.id);
      socketRoom.set(socket.id, room.code);
      socket.join(room.code);
      broadcast(io, room);
      resumeIfIdle(io, room);
    });

    socket.on("sit", ({ seat } = {}) => {
      const room = getRoom(socketRoom.get(socket.id));
      if (!room) return;
      if (room.match) return socket.emit("errorMessage", "\u5f00\u5c40\u540e\u4e0d\u80fd\u6362\u5ea7\u4f4d");
      const index = Number(seat);
      if (!Number.isInteger(index) || index < 0 || index > 3) return socket.emit("errorMessage", "\u5ea7\u4f4d\u65e0\u6548");
      const from = room.seats.findIndex((item) => item?.socketId === socket.id);
      if (from < 0 || from === index) return;
      const target = room.seats[index];
      if (target && !target.bot) return socket.emit("errorMessage", "\u8be5\u5ea7\u4f4d\u5df2\u6709\u73a9\u5bb6");
      room.seats[index] = {
        name: room.seats[from].name,
        socketId: socket.id,
        bot: false,
        hosted: false,
        token: room.seats[from].token || null
      };
      room.seats[from] = null;
      broadcast(io, room);
    });

    socket.on("leave", () => {
      const code = socketRoom.get(socket.id);
      socketRoom.delete(socket.id);
      const room = getRoom(code);
      if (!room) return;
      if (typeof socket.leave === "function") socket.leave(room.code);
      const seat = room.seats.findIndex((item) => item?.socketId === socket.id);
      if (seat >= 0) {
        const inMatch = Boolean(room.match) && room.match.phase !== "matchOver";
        room.seats[seat] = inMatch
          ? { ...room.seats[seat], socketId: null, bot: true, hosted: true }
          : null;
        if (room.hostId === socket.id) {
          const next = room.seats.find((item) => item?.socketId);
          room.hostId = next ? next.socketId : null;
        }
      }
      if (room.seats.some((item) => item?.socketId)) {
        broadcast(io, room);
        resumeIfIdle(io, room);
      } else {
        clearRoomTimers(room);
        scheduleRoomCleanup(room);
      }
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
        scheduleRoomCleanup(room);
      } else {
        broadcast(io, room);
        resumeIfIdle(io, room);
      }
    });
  });
}
