// Optional local smoke test; no external automation dependency or downloads.
// Usage: node scripts/browser-smoke.mjs <path-to-chrome-or-edge>
// Browser profile and screenshots stay in tmp-browser-smoke/ inside the project.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const executable = process.argv[2];
assert.ok(executable, "Pass a local Chrome/Edge executable path");
const dir = path.resolve("tmp-browser-smoke");
await mkdir(dir, { recursive: true });
const server = spawn(process.execPath, ["server/index.js"], {
  env: { ...process.env, HOST: "127.0.0.1", PORT: "3317" }, stdio: "ignore"
});
let browser;
let ws;
async function waitFor(url) {
  for (let n = 0; n < 80; n += 1) {
    try { const res = await fetch(url); if (res.ok) return res; } catch {}
    await sleep(150);
  }
  throw new Error(`Timeout: ${url}`);
}
try {
  await waitFor("http://127.0.0.1:3317/health");
  browser = spawn(executable, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=9337", `--user-data-dir=${dir}/profile`, "about:blank"], { stdio: "ignore" });
  const targets = await (await waitFor("http://127.0.0.1:9337/json/list")).json();
  ws = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails);
    if (!msg.id) return;
    const callbacks = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) callbacks.reject(new Error(JSON.stringify(msg.error)));
    else callbacks.resolve(msg.result);
  };
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function until(expression) {
    for (let n = 0; n < 80; n += 1) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    throw new Error(`Timeout: ${expression}`);
  }
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Storage.clearDataForOrigin", { origin: "http://127.0.0.1:3317", storageTypes: "all" });
  console.log("Browser:", (await call("Browser.getVersion")).product);
  await call("Page.navigate", { url: "http://127.0.0.1:3317" });
  await until("typeof socket !== 'undefined' && socket.connected");
  for (const width of [1920, 1440, 720, 390]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(100);
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `Lobby overflow ${width}`);
    await evaluate("document.getElementById('lobbyHelpBtn').click()");
    assert.equal(await evaluate("document.getElementById('helpDialog').open"), true);
    assert.equal(await evaluate("document.getElementById('helpLiveNote').hidden"), true);
    assert.equal(await evaluate("document.getElementById('helpDialog').contains(document.activeElement)"), true);
    assert.equal(await evaluate("(() => { const d = document.getElementById('helpDialog'); const r = d.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && d.scrollWidth <= d.clientWidth; })()"), true, `Help overflow ${width}`);
    const shot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(dir, `help-${width}.png`), Buffer.from(shot.data, "base64"));
    await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await until("!document.getElementById('helpDialog').open");
    await until("document.activeElement.id === 'lobbyHelpBtn'");
    console.log(`PASS lobby/help/Escape/focus at ${width}px`);
  }
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate("document.getElementById('lobbyHelpBtn').click(); document.getElementById('helpClose').click()");
  await until("!document.getElementById('helpDialog').open && document.activeElement.id === 'lobbyHelpBtn'");
  await evaluate("document.getElementById('lobbyHelpBtn').click(); document.getElementById('helpDone').click()");
  await until("!document.getElementById('helpDialog').open && document.activeElement.id === 'lobbyHelpBtn'");
  await evaluate("document.getElementById('lobbyHelpBtn').click()");
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x: 2, y: 2, button: "left", clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: 2, y: 2, button: "left", clickCount: 1 });
  await until("!document.getElementById('helpDialog').open");
  const lobbyShot = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(dir, "lobby.png"), Buffer.from(lobbyShot.data, "base64"));
  await evaluate("document.getElementById('createBtn').click()");
  await until("state && state.code");
  await evaluate("document.getElementById('botBtn').click()");
  await until("state.seats.every(Boolean)");
  await evaluate("document.getElementById('startBtn').click()");
  await until("state.match?.phase === 'play'");
  for (const width of [1920, 1440, 720, 390]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(100);
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `Table overflow ${width}`);
    await evaluate("document.getElementById('helpBtn').click()");
    assert.equal(await evaluate("document.getElementById('helpLiveNote').hidden"), false);
    await evaluate("document.getElementById('helpDone').click()");
    await until("!document.getElementById('helpDialog').open");
    await until("document.activeElement.id === 'helpBtn'");
    console.log(`PASS table/help/live warning at ${width}px`);
  }
  // Isolate deterministic interaction fixtures from the real bot timer. These
  // fixtures test browser UI; engine tests separately verify disclosure rules.
  await evaluate(`socket.disconnect(); renderEpoch += 1; stateQueue = []; pumping = false;
    globalThis.savedRoom = structuredClone(state);
    const hand = [
      {id:'a', deck:0, suit:'S', rank:3}, {id:'b', deck:0, suit:'H', rank:3},
      {id:'c', deck:0, suit:'D', rank:3}, {id:'d', deck:0, suit:'S', rank:6}
    ];
    state.match.hand = hand; state.match.turn = state.you;
    state.match.current = {type:'single', label:'单张', rank:4, length:1, cards:[{id:'previous',deck:0,suit:'C',rank:4}]};
    state.match.lastPlay = {seat:(state.you+1)%4, combo:state.match.current};
    state.match.handsCount[state.you] = hand.length; selected.clear(); handOwner = null;
    render(state);`);
  async function mouse(type, x, y) {
    await call("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
  }
  async function point(id) {
    return evaluate(`(() => { const r = document.querySelector('#hand [data-id="${id}"]').getBoundingClientRect(); return { x:r.left+10, y:r.top+10 }; })()`);
  }
  async function clickCard(id) {
    const p = await point(id);
    await mouse("mousePressed", p.x, p.y);
    await mouse("mouseReleased", p.x, p.y);
  }
  for (const width of [1440, 390]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate("selected.clear(); renderHand(state.match)");
    await clickCard('a');
    const p = await point('b');
    assert.equal(await evaluate(`document.elementFromPoint(${p.x},${p.y}).closest('.card').dataset.id`), 'b', 'selected upper card covers lower card');
    await clickCard('b');
    assert.deepEqual(await evaluate('[...selected]'), ['a', 'b']);
    await evaluate("document.getElementById('passBtn').click()");
    assert.equal(await evaluate("selected.size === 0 && !document.querySelector('#hand .up')"), true);
    await evaluate("document.getElementById('swipeBtn').click()");
    let a = await point('a'), c = await point('c');
    await mouse('mousePressed', a.x, a.y);
    await mouse('mouseMoved', c.x, c.y);
    await mouse('mouseReleased', c.x, c.y);
    assert.deepEqual(await evaluate('[...selected]'), ['a', 'b', 'c'], 'swipe selects exposed cards');
    a = await point('a'); c = await point('c');
    await mouse('mousePressed', a.x, a.y);
    await mouse('mouseMoved', c.x, c.y);
    await mouse('mouseReleased', c.x, c.y);
    assert.equal(await evaluate('selected.size'), 0, 'swipe from selected card deselects');
    // Touch cancellation must roll back the in-progress gesture.
    a = await point('a');
    await call('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[{x:a.x,y:a.y}]});
    await call('Input.dispatchTouchEvent', {type:'touchCancel', touchPoints:[]});
    assert.equal(await evaluate('selected.size'), 0);
    // Real touch swipe also works with the coarse-pointer CSS.
    await call('Emulation.setTouchEmulationEnabled', {enabled:true});
    a = await point('a'); c = await point('c');
    await call('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[{x:a.x,y:a.y}]});
    await call('Input.dispatchTouchEvent', {type:'touchMove', touchPoints:[{x:c.x,y:c.y}]});
    await call('Input.dispatchTouchEvent', {type:'touchEnd', touchPoints:[]});
    assert.deepEqual(await evaluate('[...selected]'), ['a', 'b', 'c'], 'touch swipe');
    await call('Emulation.setTouchEmulationEnabled', {enabled:false});
    await evaluate("document.getElementById('swipeBtn').click(); selected.clear(); renderHand(state.match)");
    a = await point('a'); const d = await point('d');
    await mouse('mousePressed', a.x, a.y);
    await mouse('mouseMoved', d.x, d.y);
    await mouse('mouseReleased', d.x, d.y);
    assert.equal(await evaluate("handPiles.some(p => p.includes('a') && p.includes('d'))"), true, 'drag grouping retained');
    await evaluate('handOwner = null; handPilesCustom = false; handPiles = []; pilesByOwner.clear(); renderHand(state.match)');
    console.log(`PASS stacking/pass/swipe/touch/drag at ${width}px`);
  }
  await evaluate(`state.match.phase = 'roundOver'; state.match.roundResult = {levelRank:15, finishOrder:[0,2,1,3]};
    state.match.revealedHands = [{seat:1,cards:state.match.hand}, {seat:3,cards:state.match.hand.slice(0,2)}]; render(state);`);
  assert.equal(await evaluate("document.querySelectorAll('#remainingHands .card').length"), 6);
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, 'reveal overflow');
  await evaluate("state.match.phase = 'matchOver'; render(state)");
  assert.equal(await evaluate("document.getElementById('remainingHands').classList.contains('hidden')"), false);
  await evaluate("state.match.phase = 'play'; state.match.revealedHands = []; render(state)");
  assert.equal(await evaluate("document.querySelectorAll('#remainingHands .card').length"), 0);
  console.log('PASS settlement reveal / next-round cleanup');
  assert.deepEqual(errors, [], "Browser uncaught exceptions");
  console.log("PASS all browser smoke checks");
  await call("Browser.close");
} finally {
  ws?.close();
  browser?.kill();
  server.kill();
}
