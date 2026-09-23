import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { attachSockets } from "./rooms.js";

function makeIo() {
  const io = { sockets: { sockets: new Map() }, connect: null };
  io.on = (event, fn) => {
    if (event === "connection") io.connect = fn;
  };
  return io;
}

function makeSocket(io, id) {
  const socket = {
    id,
    events: [],
    handlers: new Map(),
    on(event, fn) {
      socket.handlers.set(event, fn);
      return socket;
    },
    emit(event, payload) {
      socket.events.push({ event, payload });
      return socket;
    },
    join() {
      return socket;
    },
    fire(event, payload) {
      const fn = socket.handlers.get(event);
      if (fn) fn(payload);
    },
    last(event) {
      for (let i = socket.events.length - 1; i >= 0; i -= 1) {
        if (socket.events[i].event === event) return socket.events[i].payload;
      }
      return null;
    }
  };
  io.sockets.sockets.set(id, socket);
  return socket;
}

test("整局对战：机器人自动出牌，提示可以循环切换", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const io = makeIo();
  attachSockets(io);
  const host = makeSocket(io, "host");
  io.connect(host);
  host.fire("create", { name: "小明" });
  host.fire("fillBots");
  host.fire("start");

  let state = host.last("state");
  assert.equal(state.you, 0);
  assert.equal(state.match.phase, "play");
  assert.deepEqual(state.match.handsCount, [27, 27, 27, 27]);

  let hintSamples = null;
  let guard = 0;
  while (state.match.phase === "play" && guard < 3000) {
    if (state.match.turn === 0) {
      host.fire("hint");
      const first = host.last("hint");
      assert.ok(first, "轮到自己时应该能拿到提示");
      assert.ok(first.reason, "提示应该带出牌理由");
      if (!hintSamples && first.total > 1) {
        const seen = [first.cardIds.slice().sort().join(",")];
        for (let i = 1; i < Math.min(4, first.total); i += 1) {
          host.fire("hint");
          seen.push(host.last("hint").cardIds.slice().sort().join(","));
        }
        hintSamples = seen;
      }
      if (first.action === "pass") host.fire("pass");
      else host.fire("play", { cardIds: first.cardIds });
    } else {
      mock.timers.tick(2801);
    }
    const error = host.last("errorMessage");
    assert.ok(!error, "出牌被拒: " + String(error));
    state = host.last("state");
    guard += 1;
  }

  assert.equal(state.match.phase, "roundOver");
  assert.equal(state.match.finishOrder.length, 4);
  assert.ok(guard < 3000, "对局没有正常收敛");
  if (hintSamples) assert.ok(new Set(hintSamples).size > 1, "提示应该给出不同选择");
});
