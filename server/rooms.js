import { generatePlays } from "./game/moves.js";
import { autoAct, createMatch, levelRankOf, playCards, passTurn, publicState, returnTribute, startRound } from "./game/engine.js";

const rooms = new Map();
const socketRoom = new Map();

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
    you: seat
  };
}

function broadcast(io, room) {
  for (const [id, socket] of io.sockets.sockets) {
    if (socketRoom.get(id) !== room.code) continue;
    socket.emit("state", serializeRoom(room, id));
  }
}

function namesOf(room) {
  return room.seats.map((seat, index) => seat?.name ?? `空位${index + 1}`);
}

function botsOf(room) {
  return room.seats.map((seat) => Boolean(seat?.bot));
}

function filled(room) {
  return room.seats.every(Boolean);
}

export function attachSockets(io) {
  const runBots = (room) => {
    if (!room.match) return;
    let guard = 0;
    while (guard < 240) {
      guard += 1;
      const match = room.match;
      const seat =
        match.phase === "returnTribute"
          ? match.returnsPlan[0]?.from
          : match.phase === "play"
            ? match.turn
            : null;
      if (seat == null) break;
      if (!room.seats[seat]?.bot) break;
      const result = autoAct(match, seat);
      if (!result?.ok) break;
    }
  };

  io.on("connection", (socket) => {
    socket.on("create", ({ name }) => {
      const code = randomCode();
      const room = {
        code,
        hostId: socket.id,
        seats: [null, null, null, null],
        match: null
      };
      room.seats[0] = { name: String(name || "玩家").slice(0, 12), socketId: socket.id, bot: false };
      rooms.set(code, room);
      socketRoom.set(socket.id, code);
      socket.join(code);
      broadcast(io, room);
    });

    socket.on("join", ({ name, code }) => {
      const room = getRoom(code);
      if (!room) return socket.emit("errorMessage", "房间不存在");
      const existing = room.seats.findIndex((seat) => seat?.name === name && !seat.bot && !seat.socketId);
      const empty = room.seats.findIndex((seat) => !seat);
      const seat = existing >= 0 ? existing : empty;
      if (seat < 0) return socket.emit("errorMessage", "房间已满");
      room.seats[seat] = {
        name: String(name || `玩家${seat + 1}`).slice(0, 12),
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
      const botNames = ["北风", "东风", "西风"];
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
      if (!filled(room)) return socket.emit("errorMessage", "满4人才能开局，空位可以加机器人");
      room.match = createMatch(namesOf(room), { bots: botsOf(room) });
      startRound(room.match);
      runBots(room);
      broadcast(io, room);
    });

    socket.on("play", ({ cardIds }) => {
      const room = getRoom(socketRoom.get(socket.id));
      if (!room?.match) return;
      const seat = room.seats.findIndex((item) => item?.socketId === socket.id);
      const result = playCards(room.match, seat, cardIds ?? []);
      if (!result.ok) return socket.emit("errorMessage", result.error);
      runBots(room);
      broadcast(io, room);
    });

    socket.on("pass", () => {
      const room = getRoom(socketRoom.get(socket.id));
      if (!room?.match) return;
      const seat = room.seats.findIndex((item) => item?.socketId === socket.id);
      const result = passTurn(room.match, seat);
      if (!result.ok) return socket.emit("errorMessage", result.error);
      runBots(room);
      broadcast(io, room);
    });

    socket.on("returnTribute", ({ cardId }) => {
      const room = getRoom(socketRoom.get(socket.id));
      if (!room?.match) return;
      const seat = room.seats.findIndex((item) => item?.socketId === socket.id);
      const result = returnTribute(room.match, seat, cardId);
      if (!result.ok) return socket.emit("errorMessage", result.error);
      runBots(room);
      broadcast(io, room);
    });

    socket.on("nextRound", () => {
      const room = getRoom(socketRoom.get(socket.id));
      if (!room?.match) return;
      if (room.match.phase !== "roundOver") return;
      startRound(room.match);
      runBots(room);
      broadcast(io, room);
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
        socket.emit("hint", { cardIds: [match.hands[seat][0]?.id].filter(Boolean), action: "return" });
        return;
      }
      if (match.phase !== "play" || match.turn !== seat) return;
      const plays = generatePlays(match.hands[seat], levelRankOf(match), match.current);
      if (!plays.length) return socket.emit("hint", { cardIds: [], action: "pass" });
      socket.emit("hint", { cardIds: plays[0].cards.map((card) => card.id), action: "play" });
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
      if (!alive) rooms.delete(room.code);
      else broadcast(io, room);
    });
  });
}
