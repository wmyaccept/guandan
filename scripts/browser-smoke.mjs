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
  assert.equal(await evaluate("new URL(location.href).searchParams.get('room') === state.code"), true, 'room URL follows created room');
  const createdCode = await evaluate("state.code");
  await call('Page.reload');
  await until("typeof state !== 'undefined' && state?.code === " + JSON.stringify(createdCode));
  console.log('PASS room URL / refresh back to seat');
  assert.equal(await evaluate("document.querySelectorAll('.empty-seat').length"), 3);
  assert.equal(await evaluate("document.getElementById('gatheringNote').textContent.includes('还差 3 位')"), true);
  await evaluate(`(async () => { globalThis.chatGuest = io(); await new Promise(resolve => chatGuest.on('connect', resolve));
    chatGuest.emit('join', {code:state.code,name:'来喝茶的朋友'}); })()`);
  await until("state.seats.filter(Boolean).length === 2");
  await until("document.getElementById('chatLog').textContent.includes('来喝茶的朋友到了')");
  assert.equal(await evaluate("document.getElementById('gatheringNote').textContent.includes('来喝茶的朋友入座')"), true);
  await evaluate("void chatGuest.emit('gesture', {seat:state.you,kind:'tea'})");
  await until("document.getElementById('gatheringNote').textContent.includes('给你续了一杯茶')");
  await evaluate("document.querySelector('#quickChat button').click()");
  await until("document.getElementById('chatLog').textContent.includes('谢谢配合')");
  await evaluate("document.querySelectorAll('#quickChat button')[2].click()");
  await until("document.getElementById('chatStatus').textContent.includes('两秒')");
  await evaluate(`void chatGuest.emit('chat', {text:'<img src=x onerror="alert(1)">'});`);
  await until("document.getElementById('chatLog').textContent.includes('<img')");
  assert.equal(await evaluate("document.querySelectorAll('#chatLog img').length"), 0, 'chat must render as text');
  assert.equal(await evaluate("document.getElementById('chatCount').classList.contains('unread')"), true);
  await evaluate("document.getElementById('chatPanel').open = true");
  await until("!document.getElementById('chatCount').classList.contains('unread')");
  await evaluate("document.getElementById('chatPanel').open = false");
  await evaluate(`globalThis.originalClipboard = navigator.clipboard.writeText;
    navigator.clipboard.writeText = async text => { globalThis.copiedInvite = text; };
    document.getElementById('inviteBtn').click();`);
  await until("globalThis.copiedInvite?.includes(state.code)");
  assert.equal(await evaluate("globalThis.copiedInvite.includes('?room=' + state.code)"), true);
  await evaluate(`navigator.clipboard.writeText = async () => { throw Error('denied'); };
    document.getElementById('inviteBtn').click();`);
  await until("!document.getElementById('inviteFallback').classList.contains('hidden')");
  assert.equal(await evaluate("document.getElementById('inviteFallback').value.includes(state.code)"), true);
  await evaluate("navigator.clipboard.writeText = originalClipboard; document.getElementById('inviteFallback').classList.add('hidden')");
  for (const width of [1440, 390]) {
    await call('Emulation.setDeviceMetricsOverride', {width, height:900, deviceScaleFactor:1, mobile:false});
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    const shot = await call('Page.captureScreenshot', {format:'png'});
    await writeFile(path.join(dir, `courtyard-waiting-${width}.png`), Buffer.from(shot.data, 'base64'));
  }
  await evaluate("chatGuest.emit('leave'); void chatGuest.disconnect()");
  await until("state.seats.filter(Boolean).length === 1");
  await evaluate("document.getElementById('botBtn').click()");
  await until("state.seats.every(Boolean)");
  await until("document.querySelector('#chatLog .bot')");
  await evaluate("document.getElementById('botTalk').click()");
  assert.equal(await evaluate("document.querySelectorAll('#chatLog .bot').length"), 0);
  await evaluate("document.getElementById('botTalk').click()");
  assert.equal(await evaluate("document.querySelectorAll('#chatLog .bot').length > 0"), true);
  console.log('PASS waiting / chat delivery / identity / XSS / cooldown / invite fallback / bot mute');
  await evaluate("document.getElementById('startBtn').click()");
  await until("state.match?.phase === 'play'");
  for (const width of [1920, 1440, 720, 390]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(100);
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `Table overflow ${width}`);
    assert.equal(await evaluate(`(() => {
      const tea = document.querySelector('.table-tea'); if (!tea.checkVisibility()) return true;
      const t = tea.getBoundingClientRect();
      return [...document.querySelectorAll('.board .seat')].every(seat => {
        const r = seat.getBoundingClientRect(); return t.right <= r.left || t.left >= r.right || t.bottom <= r.top || t.top >= r.bottom;
      });
    })()`), true, 'tea decoration does not cover seats');
    assert.equal(await evaluate("(() => { const board = document.querySelector('.board').getBoundingClientRect(); const banner = document.getElementById('banner').getBoundingClientRect(); return banner.bottom <= board.bottom && banner.top >= board.top; })()"), true, `Banner clipped ${width}`);
    assert.equal(await evaluate(`(() => {
      return ['swipeBtn','groupBtn','hintBtn','passBtn','playBtn'].every(id => {
        const el = document.getElementById(id), r = el.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
      });
    })()`), true, `Controls outside viewport ${width}`);
    await evaluate("document.getElementById('helpBtn').click()");
    assert.equal(await evaluate("document.getElementById('helpLiveNote').hidden"), false);
    await evaluate("document.getElementById('helpDone').click()");
    await until("!document.getElementById('helpDialog').open");
    await until("document.activeElement.id === 'helpBtn'");
    const shot = await call('Page.captureScreenshot', {format:'png'});
    await writeFile(path.join(dir, `courtyard-table-${width}.png`), Buffer.from(shot.data, 'base64'));
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
  await evaluate(`state.match.phase = 'roundOver'; state.match.roundResult = {levelRank:15, finishOrder:[0,2,1,3], notes:{plays:38,winds:2}};
    state.match.revealedHands = [{seat:1,cards:state.match.hand}, {seat:3,cards:state.match.hand.slice(0,2)}]; render(state);`);
  assert.equal(await evaluate("document.querySelectorAll('#remainingHands .card').length"), 6);
  assert.equal(await evaluate("document.getElementById('roundNotes').textContent.includes('出牌 38 手')"), true);
  assert.equal(await evaluate("document.querySelectorAll('#roundPlaces li').length"), 4);
  for (const width of [1440,390]) {
    await call('Emulation.setDeviceMetricsOverride', {width,height:900,deviceScaleFactor:1,mobile:false});
    await evaluate("document.getElementById('roundNotes').scrollIntoView({block:'center'})");
    assert.equal(await evaluate("(() => { const r = document.getElementById('roundContinue').getBoundingClientRect(), f = document.querySelector('.felt').getBoundingClientRect(); return r.top >= f.top && r.bottom <= f.bottom && r.bottom <= innerHeight; })()"), true, 'settlement continue reachable');
    const shot = await call('Page.captureScreenshot', {format:'png'});
    await writeFile(path.join(dir, `settlement-${width}.png`), Buffer.from(shot.data,'base64'));
  }
  await evaluate("globalThis.continued = ''; const originalEmit = socket.emit; socket.emit = event => { continued = event; }; document.getElementById('roundContinue').click(); socket.emit = originalEmit;");
  assert.equal(await evaluate("continued"), 'nextRound');
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, 'reveal overflow');
  await evaluate("state.match.phase = 'matchOver'; render(state)");
  assert.equal(await evaluate("document.getElementById('remainingHands').classList.contains('hidden')"), false);
  await evaluate("state.match.phase = 'play'; state.match.revealedHands = []; render(state)");
  assert.equal(await evaluate("document.querySelectorAll('#remainingHands .card').length"), 0);
  assert.equal(await evaluate("document.getElementById('roundNotes').classList.contains('hidden')"), true);
  for (const [width, height] of [[720,560], [390,640]]) {
    await call('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:false});
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    await evaluate("document.getElementById('chatPanel').open = false");
    assert.equal(await evaluate("document.getElementById('chatForm').getBoundingClientRect().height === 0 || !document.getElementById('chatInput').checkVisibility()"), true);
  }
  console.log('PASS settlement reveal / brief notes / next-round cleanup / short viewport');
  // Full-deal and tall custom stacks must stay reachable, including at max zoom.
  await evaluate(`state = structuredClone(savedRoom); state.match.turn = state.you;
    state.match.phase = 'play'; state.match.current = null; selected.clear();
    handOwner = null; handPilesCustom = false; pilesByOwner.clear(); render(state);`);
  for (const [width,height] of [[1440,900],[390,640],[720,560],[844,390]]) {
    await call('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:false});
    for (const scale of [1,1.6]) {
      await evaluate(`setZoom(${scale}); document.getElementById('chatPanel').open = false`);
      await sleep(120);
      const geometry = await evaluate(`(() => {
        const scroller = document.getElementById('handScroll');
        const outer = document.querySelector('.felt'); outer.scrollTop = outer.scrollHeight;
        const result = {};
        for (const id of ['swipeBtn','playBtn','passBtn']) {
          const r = document.getElementById(id).getBoundingClientRect();
          result[id] = {left:r.left,right:r.right,top:r.top,bottom:r.bottom};
        }
        result.width = document.documentElement.scrollWidth;
        result.card = document.querySelector('#hand .card').getBoundingClientRect().toJSON();
        result.scroll = {width:scroller.clientWidth,full:scroller.scrollWidth};
        return result;
      })()`);
      for (const id of ['swipeBtn','playBtn','passBtn']) {
        const r = geometry[id];
        assert.ok(r.left >= 0 && r.right <= width && r.top >= 0 && r.bottom <= height, `${id} ${width}x${height} zoom${scale}: ${JSON.stringify(r)}`);
      }
      assert.ok(geometry.width <= width);
      assert.ok(geometry.card.height > geometry.card.width * 1.8, 'keep tall rectangular cards');
      if (geometry.scroll.full > geometry.scroll.width + 2) {
        await evaluate("document.getElementById('handScroll').scrollLeft = 0; updateHandNavigation(); document.getElementById('handNext').click()");
        await until("document.getElementById('handScroll').scrollLeft > 0");
        await evaluate("document.getElementById('handScroll').scrollLeft = document.getElementById('handScroll').scrollWidth");
        await until("document.getElementById('handNext').disabled");
      }
    }
    await evaluate("setZoom(1); document.querySelector('.felt').scrollTop = 0; document.getElementById('handScroll').scrollLeft = 0");
    await sleep(100);
    if (width >= 650 && height <= 500) {
      assert.equal(await evaluate("(() => { const r = document.getElementById('playBtn').getBoundingClientRect(), f = document.querySelector('.felt').getBoundingClientRect(); return r.top >= f.top && r.bottom <= f.bottom && r.bottom <= innerHeight; })()"), true, 'landscape actions visible without outer scrolling or clipping');
    }
    const shot = await call('Page.captureScreenshot', {format:'png'});
    await writeFile(path.join(dir, `layout-${width}x${height}.png`), Buffer.from(shot.data, 'base64'));
  }
  await evaluate(`selected.clear(); for (const card of state.match.hand.slice(0,8)) selected.add(card.id);
    document.getElementById('groupBtn').click(); setZoom(1.6);`);
  assert.equal(await evaluate("document.querySelector('#hand .pile').querySelectorAll('.card').length === 8 || [...document.querySelectorAll('#hand .pile')].some(p => p.querySelectorAll('.card').length === 8)"), true);
  assert.equal(await evaluate("selected.size"), 0, 'grouped cards are put down');
  assert.equal(await evaluate("(() => { const s = document.getElementById('handScroll'); s.scrollTop = s.scrollHeight; return s.scrollTop > 0 && s.scrollHeight - s.clientHeight - s.scrollTop < 2; })()"), true, 'tall group can be scrolled to bottom');
  console.log('PASS full hand / visible controls / scroll reach / zoom / landscape');
  // Shared Joker renderer: color distinction survives skins, small cards and selection.
  await call('Emulation.setDeviceMetricsOverride', {width:1000,height:760,deviceScaleFactor:1,mobile:false});
  await evaluate(`(() => {
    const preview = document.createElement('div'); preview.id = 'jokerPreview';
    preview.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#302c26;padding:28px;display:flex;gap:24px;flex-wrap:wrap;align-content:start;overflow:auto';
    for (const skin of ['classic','pearl','kraft','ink','jade']) {
      const group = document.createElement('section'); group.dataset.cardSkin = skin;
      group.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;width:280px';
      const title = document.createElement('p'); title.textContent = skin; title.style.width = '100%'; group.append(title);
      for (const rank of [16,17]) {
        const card = renderCard({id:'joker-'+skin+'-'+rank,rank,suit:'J'},15);
        card.style.setProperty('--zoom','1.25'); group.append(card);
      }
      const small = renderCard({id:'small-'+skin,rank:16,suit:'J'},15);
      small.style.setProperty('--zoom','.65'); group.append(small); preview.append(group);
    }
    document.body.append(preview);
  })()`);
  await until("[...document.querySelectorAll('#jokerPreview img')].every(img => img.complete && img.naturalWidth > 0)");
  assert.equal(await evaluate("[...document.querySelectorAll('#jokerPreview .joker-small .joker-art')].every(img => getComputedStyle(img).filter === 'grayscale(1)')"), true);
  assert.equal(await evaluate("[...document.querySelectorAll('#jokerPreview .joker-big .joker-art')].every(img => getComputedStyle(img).filter === 'none')"), true);
  assert.equal(await evaluate("document.querySelector('#jokerPreview .joker-big').getAttribute('aria-label')"), '大王');
  assert.equal(await evaluate("document.querySelector('#jokerPreview .joker-small').getAttribute('aria-label')"), '小王');
  const jokerShot = await call('Page.captureScreenshot', {format:'png'});
  await writeFile(path.join(dir, 'jokers.png'), Buffer.from(jokerShot.data, 'base64'));
  await evaluate("document.querySelector('#jokerPreview [data-card-skin=ink]').classList.add('hand'); document.querySelector('#jokerPreview [data-card-skin=ink] .joker-small').classList.add('up')");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#jokerPreview [data-card-skin=ink] .joker-small')).backgroundImage.includes('rgb(255, 253, 246)')"), true, 'selected dark-skin Joker retains readable paper face');
  await evaluate("document.getElementById('jokerPreview').remove()");
  console.log('PASS Joker artwork / grayscale / five skins / accessible labels');
  await call('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await evaluate("document.getElementById('gestureLayer').replaceChildren(); playGesture(1,you,'tea','来喝茶的朋友')");
  assert.equal(await evaluate("document.getElementById('gatheringNote').textContent.includes('续了一杯茶') && !document.getElementById('gestureLayer').children.length"), true);
  await evaluate("document.getElementById('roundLeave').click()");
  assert.equal(await evaluate("!document.getElementById('lobby').classList.contains('hidden') && !new URL(location.href).searchParams.has('room')"), true);
  await call('Page.navigate', {url:'http://127.0.0.1:3317/?room=Z9Z9'});
  await until("typeof socket !== 'undefined' && socket.connected");
  assert.equal(await evaluate("document.getElementById('code').value"), 'Z9Z9');
  assert.equal(await evaluate("document.getElementById('lobbyError').textContent.includes('朋友给你留了座')"), true);
  console.log('PASS reduced motion / return home / invitation prefill');
  assert.deepEqual(errors, [], "Browser uncaught exceptions");
  console.log("PASS all browser smoke checks");
  await call("Browser.close");
} finally {
  ws?.close();
  browser?.kill();
  server.kill();
}
