import assert from "node:assert/strict";
import test from "node:test";
import { startPlayer } from "../src/player.js";

class Element {
  get disabled() { return this._disabled; }
  set disabled(value) {
    this._disabled = value;
    if (value && typeof document !== "undefined" && document.activeElement === this) document.activeElement = document.body;
  }
  constructor(tagName = "DIV") {
    this.tagName = tagName.toUpperCase(); this.dataset = {}; this.children = [];
    this.attributes = {}; this.listeners = {}; this.hidden = false; this.disabled = false;
    const classes = new Set();
    this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) };
  }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter(item => item !== fn); }
  async emit(name, values = {}) { await Promise.all((this.listeners[name] || []).map(fn => fn({ target: this, preventDefault() {}, ...values }))); }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
  replaceChildren() { this.children = []; }
  contains(item) { return item === this || this.children.some(child => child.contains(item)); }
  matches(selector) {
    if (selector === "video") return this.tagName === "VIDEO";
    if (selector === ".player-controls") return this.className === "player-controls";
    const match = selector.match(/^\[data-([\w-]+)(?:="([^"]*)")?\]$/);
    if (!match) return false;
    const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    return Object.hasOwn(this.dataset, key) && (match[2] === undefined || this.dataset[key] === match[2]);
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector); }
  focus() { document.activeElement = this; }
}

function harness(t, { subtitleUrl = "", subtitleDelay = 0, hlsUrl = "", progressToken = "", fetchImpl, storageFails = false } = {}) {
  const doc = new Element(); doc.createElement = tag => new Element(tag); doc.body = new Element("body"); doc.activeElement = doc.body;
  const win = new Element(); let reloads = 0; win.location = { reload() { reloads++; } };
  const root = new Element(); root.dataset = { version: "3", serverInstanceId: "instance", subtitleUrl, subtitleDelay: String(subtitleDelay), subtitleLanguage: "en", hlsUrl, progressToken, resumeKey: "movie" }; doc.append(root);
  const video = new Element("video"); Object.assign(video, { volume: 0.6, muted: false, paused: true, ended: false, currentTime: 120, duration: 1800, readyState: 3 }); root.append(video);
  const controls = new Element(); controls.className = "player-controls"; root.append(controls);
  const parts = {};
  for (const name of ["caption", "message", "seek-feedback", "clock", "subtitle-sync-status"]) { const node = new Element(); node.dataset.playerPart = name; root.append(node); parts[name] = node; }
  for (const name of ["play", "seek", "mute", "volume", "captions", "fullscreen", "retry", "subtitle-retry", "subtitle-sync", "audio"]) { const node = new Element(name === "audio" ? "select" : name === "seek" || name === "volume" ? "input" : "button"); node.dataset.playerControl = name; controls.append(node); parts[name] = node; }
  const local = new Element(); local.dataset.localProgress = ""; doc.append(local);
  const subtitleStatus = new Element(); subtitleStatus.dataset.subtitleStatus = ""; doc.append(subtitleStatus);
  const queue = new Element(); queue.dataset.marathon = ""; doc.append(queue);
  for (const name of ["list", "warning", "operation"]) { const node = new Element(); node.dataset[`marathon${name[0].toUpperCase()}${name.slice(1)}`] = ""; queue.append(node); }
  for (const action of ["toggle-autoplay", "advance", "undo"]) { const node = new Element("button"); node.dataset.marathonAction = action; queue.append(node); }
  const timers = new Map(); let timerId = 0;
  const originals = new Map();
  const globals = { document: doc, window: win, location: win.location, localStorage: { getItem: () => null, setItem() { if (storageFails) throw Error("blocked"); }, removeItem() {} },
    fetch: fetchImpl || (async () => Response.json({ version: 3, serverInstanceId: "instance", subtitleUrl, subtitleDelay: 0 })),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout: id => timers.delete(id),
    setInterval: () => ++timerId, clearInterval() {},
  };
  for (const [key, value] of Object.entries(globals)) { originals.set(key, globalThis[key]); globalThis[key] = value; }
  const player = startPlayer(root);
  t.after(() => { player.destroy(); for (const [key, value] of originals) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  return { player, root, video, parts, queue, local, subtitleStatus, win, doc, reloads: () => reloads,
    expire: delay => { for (const timer of [...timers.values()]) if (timer.delay === delay) timer.fn(); },
    hide: () => { for (const timer of [...timers.values()]) if (timer.delay === 3000) timer.fn(); } };
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("HLS library reset restores play intent and clears the decoder overlay only after frames advance", async t => {
  let instance;
  class FakeHls {
    static isSupported = () => true;
    static Events = { AUDIO_TRACKS_UPDATED: "tracks", AUDIO_TRACK_SWITCHED: "switched", ERROR: "error", MEDIA_ATTACHED: "attached" };
    constructor() { instance = this; this.callbacks = {}; this.audioTracks = []; this.resets = 0; }
    on(event, fn) { this.callbacks[event] = fn; }
    attachMedia(video) { this.video = video; }
    loadSource() {}
    startLoad() {}
    stopLoad() { this.stopped = true; }
    destroy() {}
    recoverMediaError() { this.resets++; this.video.error = null; this.video.paused = true; }
  }
  const previous = globalThis.Hls; globalThis.Hls = FakeHls;
  t.after(() => { globalThis.Hls = previous; });
  const h = harness(t, { hlsUrl: "/master.m3u8" }); let frames = 100;
  h.video.videoWidth = 1920;
  h.video.getVideoPlaybackQuality = () => ({ totalVideoFrames: frames, droppedVideoFrames: 0 });
  h.video.pause = () => { h.video.paused = true; };
  h.video.play = async () => { h.video.paused = false; await h.video.emit("play"); await h.video.emit("playing"); };
  const fail = async () => {
    h.video.error = { code: 3 }; await h.video.emit("error");
    // hls.js 1.7.2 ErrorController runs this before application ERROR listeners.
    instance.recoverMediaError();
    instance.callbacks.error(null, { fatal: false, type: "mediaError", details: "mediaSourceRequiresReset" });
    instance.callbacks.attached?.(); await settle();
  };
  h.video.paused = false; await fail();
  assert.equal(instance.resets, 1, "the application must not duplicate the library reset");
  assert.equal(h.video.paused, false, "attachment restores the pre-error play intent");
  h.video.currentTime = 125; await h.video.emit("timeupdate");
  assert.equal(h.parts.retry.hidden, false, "clock progress alone cannot clear a decoder failure");
  frames = 110; await h.video.emit("timeupdate");
  assert.equal(h.parts.message.hidden, true); assert.equal(h.parts.retry.hidden, true);
  await fail(); await fail();
  assert.equal(h.video.paused, true, "a repeated failure stops continuing audio");
  assert.equal(instance.stopped, true); assert.equal(h.parts.retry.hidden, false);
  await h.parts.play.emit("click"); instance.callbacks.attached(); await settle();
  h.video.currentTime = 130; frames = 120; await h.video.emit("timeupdate");
  assert.equal(h.parts.retry.hidden, true, "manual resume can retry after a terminal failure");
});

test("zero-volume button and M restore the last audible value; sliders describe time and percent", async t => {
  const h = harness(t); h.parts.volume.value = "0"; await h.parts.volume.emit("input");
  await h.parts.mute.emit("click"); assert.equal(h.video.volume, 0.6); assert.equal(h.video.muted, false);
  h.parts.volume.value = "0"; await h.parts.volume.emit("input");
  await h.root.emit("keydown", { key: "m" }); assert.equal(h.video.volume, 0.6); assert.equal(h.video.muted, false);
  assert.equal(h.parts.volume.attributes["aria-valuetext"], "60 %");
  assert.equal(h.parts.seek.attributes["aria-valuetext"], "2:00 de 30:00");
});

test("controls remain visible on pause, end and playback failure and local storage failure is explicit", async t => {
  const h = harness(t, { storageFails: true }); h.video.paused = false; await h.video.emit("play"); h.hide();
  assert.equal(h.root.dataset.controlsState, "hidden");
  h.video.paused = true; await h.video.emit("pause"); h.hide(); assert.equal(h.root.dataset.controlsState, "visible");
  assert.match(h.local.textContent, /no permite guardar/);
  h.video.paused = false; await h.video.emit("play"); h.hide(); h.video.ended = true; await h.video.emit("ended"); h.hide();
  assert.equal(h.root.dataset.controlsState, "visible");
  h.video.ended = false; await h.video.emit("error"); h.hide(); assert.equal(h.root.dataset.controlsState, "visible");
});

test("a rejected play request keeps controls visible and a successful retry clears that failure", async t => {
  const h = harness(t);
  h.video.play = async () => { throw Error("blocked"); };
  await h.parts.play.emit("click"); await settle(); h.hide();
  assert.equal(h.root.dataset.controlsState, "visible"); assert.match(h.parts.message.textContent, /No se pudo reanudar/);
  h.video.play = async () => { h.video.paused = false; await h.video.emit("play"); };
  await h.parts.play.emit("click"); await settle();
  assert.equal(h.parts.message.hidden, true); h.hide(); assert.equal(h.root.dataset.controlsState, "hidden");
});

test("a decoder failure stops continuing audio and identifies the video error", async t => {
  const h = harness(t);
  h.video.paused = false;
  h.video.pause = () => { h.video.paused = true; };
  h.video.error = {code:3};
  await h.video.emit('error');
  assert.equal(h.video.paused,true);
  assert.match(h.parts.message.textContent,/decodificar.*vídeo/i);
  assert.equal(h.parts.retry.hidden,false);
});

test("subtitle retry uses the same URL without restarting media and ignores a superseded track", async t => {
  let attempts = 0; let oldResolve; const signals = [];
  const h = harness(t, { subtitleUrl: "/old.vtt", fetchImpl: async (url, options) => {
    if (url === "/api/status") return Response.json({ version: 3, serverInstanceId: "instance", subtitleUrl: "/old.vtt" });
    signals.push(options.signal); attempts++;
    if (attempts === 1) throw Error("offline");
    if (attempts === 2) return new Promise(resolve => { oldResolve = resolve; });
    return new Response("WEBVTT\n\n00:01.000 --> 09:00.000\nnew");
  } });
  await settle(); assert.equal(h.root.dataset.subtitleState, "error"); assert.equal(h.parts["subtitle-retry"].hidden, false);
  const oldRetry = h.parts["subtitle-retry"].emit("click");
  // A second retry cancels the previous in-flight fetch, even at the same URL.
  await h.parts["subtitle-retry"].emit("click"); await settle();
  assert.equal(signals[1].aborted, true); assert.equal(h.root.dataset.subtitleState, "ready");
  oldResolve(new Response("WEBVTT\n\n00:01.000 --> 09:00.000\nold")); await oldRetry; await settle();
  assert.equal(h.parts.caption.textContent, "new"); assert.equal(h.video.currentTime, 120); assert.equal(h.reloads(), 0);
});

test("background preparation updates subtitle availability without reloading playback", async t => {
  let status = { version: 3, serverInstanceId: "instance", subtitleUrl: "", subtitleStatus: "Buscando subtítulos…" };
  const h = harness(t, { fetchImpl: async url => url === "/api/status" ? Response.json(status)
    : new Response("WEBVTT\n\n00:01.000 --> 09:00.000\nhello") });
  await settle(); assert.equal(h.subtitleStatus.textContent, "Buscando subtítulos…");
  status = { ...status, subtitleUrl: "/english.vtt", subtitleLanguage: "en", subtitleStatus: "Subtítulos: Inglés · fuente 2" };
  await h.player.pollStatus(); await settle();
  assert.equal(h.subtitleStatus.textContent, "Subtítulos: Inglés · fuente 2");
  assert.equal(h.root.dataset.subtitleState, "ready");
  assert.equal(h.parts.caption.textContent, "hello");
  assert.equal(h.reloads(), 0); assert.equal(h.video.currentTime, 120);
});

test("status polling is single flight, aborts on pagehide and reloads a restored bfcache page", async t => {
  const signals = [];
  const h = harness(t, { fetchImpl: async (_url, options) => { signals.push(options.signal); return new Promise(() => {}); } });
  await h.player.pollStatus(); await h.player.pollStatus(); assert.equal(signals.length, 1);
  await h.win.emit("pagehide"); assert.equal(signals[0].aborted, true);
  await h.win.emit("pageshow", { persisted: true }); assert.equal(h.reloads(), 1);
});

test("status timeout frees the next poll and subtitle timeout offers an independent retry", async t => {
  const requests = [];
  const h = harness(t, { subtitleUrl: "/slow.vtt", fetchImpl: (url, options) => {
    requests.push({ url, signal: options.signal });
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Error("timeout")), { once: true }));
  } });
  h.expire(10000); h.expire(15000); await settle();
  assert.ok(requests.every(request => request.signal.aborted));
  assert.equal(h.parts["subtitle-retry"].hidden, false);
  const next = h.player.pollStatus(); assert.equal(requests.filter(request => request.url === "/api/status").length, 2);
  h.expire(10000); await next;
});

test("stale queue conflict is actionable and restores mutation controls", async t => {
  const state = { items: [{ id: "a", title: "A", prepared: true }], autoplay: false, canAdvance: true };
  const h = harness(t, { fetchImpl: async url => url === "/api/status"
    ? Response.json({ version: 3, serverInstanceId: "instance", marathon: state })
    : Response.json({ error: "stale" }, { status: 409 }) });
  await settle(); const remove = h.queue.querySelector('[data-marathon-action="remove"]'); remove.focus();
  await h.queue.emit("click", { target: remove });
  assert.match(h.queue.querySelector("[data-marathon-operation]").textContent, /fuente ha cambiado.*Recarga/);
  assert.equal(h.queue.querySelector('[data-marathon-action="remove"]').disabled, false);
  assert.equal(h.doc.activeElement.dataset.marathonId, "a");
});

test("failed episode advance clears preparation overlay and allows retry after playback ends", async t => {
  const state = { items: [{ id: "a", title: "A", prepared: true }], autoplay: false, canAdvance: true };
  const h = harness(t, { fetchImpl: async url => url === "/api/status"
    ? Response.json({ version: 3, serverInstanceId: "instance", marathon: state })
    : Response.json({ error: "unavailable" }, { status: 500 }) });
  await settle(); h.video.ended = true; await h.video.emit("ended");
  await h.queue.emit("click", { target: h.queue.querySelector('[data-marathon-action="advance"]') });
  assert.equal(h.parts.message.hidden, true);
  assert.match(h.queue.querySelector("[data-marathon-operation]").textContent, /No se pudo abrir/);
  assert.equal(h.queue.querySelector('[data-marathon-action="advance"]').disabled, false);
  assert.equal(h.reloads(), 0);
});

test("queue operations acknowledge immediately, protect session, restore focus and support undo", async t => {
  const items = [{ id: "a", title: "A", prepared: true }, { id: "b", title: "B", prepared: true }];
  let state = { items, canAdvance: true, autoplay: false }; let finish; const requests = [];
  const h = harness(t, { fetchImpl: async (url, options) => {
    if (url === "/api/status") return Response.json({ version: 3, serverInstanceId: "instance", marathon: state });
    requests.push({ url, options });
    return new Promise(resolve => { finish = resolve; });
  } });
  await settle(); const remove = h.queue.querySelectorAll('[data-marathon-action="remove"]')[0]; remove.focus();
  const pending = h.queue.emit("click", { target: remove }); await settle();
  assert.match(h.queue.querySelector("[data-marathon-operation]").textContent, /Actualizando/);
  assert.ok(h.queue.querySelectorAll("[data-marathon-action]").every(button => button.disabled));
  assert.equal(requests[0].options.body.get("version"), "3"); assert.equal(requests[0].options.body.get("serverInstanceId"), "instance");
  state = { ...state, items: [items[1]], canUndo: true, undoTitle: "A" }; finish(Response.json({ marathon: state })); await pending;
  assert.equal(h.doc.activeElement.dataset.marathonId, "b"); assert.equal(h.doc.activeElement.dataset.marathonAction, "remove");
  const undo = h.queue.querySelector('[data-marathon-action="undo"]'); assert.equal(undo.hidden, false);
  const undoPending = h.queue.emit("click", { target: undo }); await settle(); assert.equal(requests[1].url, "/api/marathon/undo");
  finish(Response.json({ marathon: { ...state, items, canUndo: false } })); await undoPending;
  state = null; await h.player.pollStatus(); assert.equal(h.queue.hidden, true);
});

test("autosync replaces a saved manual delay and later fine-tuning remains relative", async t => {
  let instance, manualDelay = -2;
  const reports = [];
  class FakeHls {
    static isSupported = () => true;
    static Events = { AUDIO_TRACKS_UPDATED: "tracks", AUDIO_TRACK_SWITCHED: "switched", ERROR: "error" };
    constructor() { instance = this; this.callbacks = {}; this.audioTracks = [{lang:"en"}]; this.audioTrack = 0; }
    on(name, fn) { this.callbacks[name] = fn; }
    loadSource() {} attachMedia() {} destroy() {}
  }
  const previous = globalThis.Hls; globalThis.Hls = FakeHls;
  t.after(() => { globalThis.Hls = previous; });
  const h = harness(t, { hlsUrl:"/master.m3u8", subtitleUrl:"/en.vtt", subtitleDelay:manualDelay, progressToken: "secret",
    fetchImpl: async (url, options) => {
      if (url === "/api/subtitle-sync/playback") { reports.push(JSON.parse(options.body)); return Response.json({}); }
      if (url === "/api/progress") return Response.json({state:"saved"});
      if (url === "/en.vtt") return new Response("WEBVTT\n\n00:02:00.000 --> 00:02:01.000\nAligned phrase\n");
      if (url === "/api/status") return Response.json({version:3,serverInstanceId:"instance",subtitleUrl:"/en.vtt",subtitleDelay:manualDelay});
      if (url === "/api/subtitle-sync") return Response.json(options.method === "POST"
        ? {state:"ready",result:{start:100,end:150,offset:1,anchors:6,residual:0.1}} : {available:true});
      throw Error("Unexpected request");
    } });
  await settle(); instance.callbacks.tracks();
  h.video.currentTime = 121.5;
  await h.parts["subtitle-sync"].emit("click"); await settle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.root.dataset.subtitleState,"ready");
  assert.equal(h.parts["subtitle-sync"].attributes["aria-pressed"],"true");
  assert.equal(h.parts["subtitle-sync-status"].textContent,"Tramo sincronizado");
  assert.equal(h.parts.caption.textContent,"Aligned phrase","saved -2s must not offset the automatic match");
  assert.equal(h.root.dataset.currentDelay,"0");
  assert.equal(reports.at(-1).automaticOffset, 1);
  assert.equal(reports.at(-1).manualBaseline, -2);
  assert.equal(reports.at(-1).enabled, true);
  manualDelay = -1;
  await h.player.pollStatus();
  assert.equal(h.root.dataset.currentDelay,"1","a later +1s manual change still shifts automatic timing");
  h.video.currentTime = 122.5; await h.video.emit("timeupdate");
  assert.equal(h.parts.caption.textContent,"Aligned phrase");
  h.expire(3000); await settle();
  assert.equal(reports.at(-1).automaticOffset, 1, "manual +1 is not added to the automatic report");
  assert.equal(reports.at(-1).manualBaseline, -2);
  assert.equal(reports.at(-1).time, 122.5);
  await h.parts["subtitle-sync"].emit("click"); await settle();
  assert.equal(h.root.dataset.currentDelay,"-1","disabling auto restores ordinary manual timing");
  assert.equal(reports.at(-1).enabled, false);
  assert.equal(reports.at(-1).manualBaseline, 0);
});
