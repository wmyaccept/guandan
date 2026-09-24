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

test("开局前可以点击空位换座位，占了别人的位置会被拒绝", () => {
  const io = makeIo();
  attachSockets(io);
  const host = makeSocket(io, "host");
  io.connect(host);
  host.fire("create", { name: "小明" });
  const code = host.last("state").code;

  host.fire("sit", { seat: 2 });
  const moved = host.last("state");
  assert.equal(moved.you, 2);
  assert.equal(moved.seats[2].name, "小明");
  assert.equal(moved.seats[0], null);

  const guest = makeSocket(io, "guest");
  io.connect(guest);
  guest.fire("join", { name: "小红", code });
  assert.equal(guest.last("state").you, 0);

  guest.fire("sit", { seat: 2 });
  assert.equal(guest.last("errorMessage"), "该座位已有玩家");
  assert.equal(guest.last("state").you, 0);

  host.fire("fillBots");
  assert.deepEqual(host.last("state").seats.map((seat) => seat.bot), [false, true, false, true]);

  guest.fire("sit", { seat: 1 });
  const swapped = guest.last("state");
  assert.equal(swapped.you, 1, "可以顶掉机器人的座位");
  assert.equal(swapped.seats[0], null);
});

test("刷新后房间保留，按昵称回到原座位，超时未回才解散", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const io = makeIo();
  attachSockets(io);
  const first = makeSocket(io, "s1");
  io.connect(first);
  first.fire("create", { name: "小明" });
  first.fire("fillBots");
  first.fire("start");
  const before = first.last("state");
  const code = before.code;
  const handBefore = before.match.hand.map((card) => card.id).join(",");

  first.fire("disconnect");

  const second = makeSocket(io, "s2");
  io.connect(second);
  second.fire("join", { name: "小明", code });
  const back = second.last("state");
  assert.equal(back.you, 0, "刷新后应该回到自己的座位");
  assert.equal(back.match.hand.map((card) => card.id).join(","), handBefore, "手牌应该原样保留");
  assert.equal(back.seats[0].connected, true);

  second.fire("disconnect");
  mock.timers.tick(11 * 60 * 1000);
  const third = makeSocket(io, "s3");
  io.connect(third);
  third.fire("join", { name: "小明", code });
  assert.equal(third.last("errorMessage"), "房间不存在");
});

test("对局中退出会把座位交给托管，牌局照常打完", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const io = makeIo();
  attachSockets(io);
  const host = makeSocket(io, "h1");
  io.connect(host);
  host.fire("create", { name: "小明" });
  const code = host.last("state").code;
  const guest = makeSocket(io, "g1");
  io.connect(guest);
  guest.fire("join", { name: "小红", code });
  host.fire("fillBots");
  host.fire("start");

  guest.fire("leave");
  const left = host.last("state");
  assert.equal(left.seats[1].name, "小红");
  assert.equal(left.seats[1].hosted, true, "退出的座位应标记为托管");
  assert.equal(left.seats[1].connected, true);

  let state = left;
  let guard = 0;
  while (state.match.phase === "play" && guard < 4000) {
    if (state.match.turn === 0) {
      host.fire("hint");
      const pick = host.last("hint");
      if (pick.action === "pass") host.fire("pass");
      else host.fire("play", { cardIds: pick.cardIds });
      const error = host.last("errorMessage");
      assert.ok(!error, "出牌被拒: " + String(error));
    } else {
      mock.timers.tick(2801);
    }
    state = host.last("state");
    guard += 1;
  }
  assert.equal(state.match.phase, "roundOver");
  assert.equal(state.match.finishOrder.length, 4);
  assert.ok(guard < 4000, "退出后牌局没有正常收敛");
});

test("刷新时旧连接尚未断开，也能按昵称收回原座位", () => {
  const io = makeIo();
  attachSockets(io);
  const first = makeSocket(io, "s1");
  io.connect(first);
  first.fire("create", { name: "小明" });
  const code = first.last("state").code;

  // 模拟浏览器被直接杀掉：连接已从连接表消失，但 disconnect 还没触发
  io.sockets.sockets.delete("s1");

  const second = makeSocket(io, "s2");
  io.connect(second);
  second.fire("join", { name: "小明", code });
  const back = second.last("state");
  assert.equal(back.you, 0, "应该收回自己的原座位");
  assert.equal(back.seats[0].name, "小明");
  assert.equal(back.seats[0].connected, true);
  const claimed = back.seats.filter((seat) => seat && seat.name === "小明").length;
  assert.equal(claimed, 1, "不应该多占一个座位");
});

test("旧连接仍被判为在线时，凭令牌也能收回原座位", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const io = makeIo();
  attachSockets(io);
  const first = makeSocket(io, "s1");
  io.connect(first);
  first.fire("create", { name: "小明", token: "tok-abcdefgh" });
  const code = first.last("state").code;
  first.fire("fillBots");
  first.fire("start");
  const handBefore = first.last("state").match.hand.map((card) => card.id).join(",");

  // 不触发 disconnect：模拟崩溃或手机切后台，服务端仍认为旧连接在线
  const second = makeSocket(io, "s2");
  io.connect(second);
  second.fire("join", { name: "小明", code, token: "tok-abcdefgh" });
  const back = second.last("state");
  assert.equal(back.you, 0, "凭令牌应该收回原座位");
  assert.equal(back.match.hand.map((card) => card.id).join(","), handBefore, "手牌应该原样保留");
  assert.equal(back.seats.filter((seat) => seat && seat.connected).length, 4, "不应该多占座位");
});
