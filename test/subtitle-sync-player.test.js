import assert from "node:assert/strict";
import test from "node:test";
import { alignedSubtitleCues, createSubtitleSyncController, cueAtTime, isEnglishLanguage } from "../src/player.js";

const flush = () => new Promise(resolve => setImmediate(resolve));
const context = { version: 1, serverInstanceId: "server", subtitleUrl: "/subtitle/0.vtt", subtitleLanguage: "eng", audioIndex: 2, audioLanguage: "en", captions: true };
const correction = { start: 10, end: 50, offset: 2, anchors: 5, residual: 0.1 };

function harness(handler) {
  const requests = [], timers = new Map(), changes = [];
  let id = 0, clock = 0;
  const controller = createSubtitleSyncController({ token: "secret", now: () => clock,
    setTimer(fn) { timers.set(++id, fn); return id; }, clearTimer(key) { timers.delete(key); },
    onChange(change) { changes.push(change); },
    fetchImpl: async (url, options) => {
      requests.push({ url, ...options });
      assert.equal(options.headers["x-unilink-token"], "secret");
      if (!options.method && !url.includes("?")) return Response.json({ available: true });
      return Response.json(await handler(url, options));
    },
  });
  controller.setContext(context);
  controller.tick(20, 900);
  return { controller, requests, timers, changes, advance(ms) { clock += ms; },
    async poll() { const entry = timers.entries().next().value; assert.ok(entry); timers.delete(entry[0]); entry[1](); await flush(); } };
}

test("bounded positive and negative corrections retain text/duration and manual delay is additive", () => {
  const cues = [{ start: 1, end: 3, text: "Outside" }, { start: 20, end: 22, text: "Hello" }, { start: 80, end: 82, text: "Outside too" }];
  for (const offset of [-2, 2]) {
    const result = alignedSubtitleCues(cues, [{ ...correction, offset }]);
    assert.deepEqual(result[0], cues[0]); assert.deepEqual(result[2], cues[2]);
    assert.equal(result[1].end - result[1].start, 2);
    assert.equal(cueAtTime(result, 20 + offset + 0.5 + 1, 1)?.text, "Hello");
    assert.equal(cueAtTime(result, 2)?.text, "Outside");
  }
  assert.equal(alignedSubtitleCues(cues, [correction, { ...correction, offset: -1 }])[1].start, 19);
});

test("correction boundaries never introduce overlaps or reorder cues", () => {
  const cues = [{ start: 8, end: 10, text: "First" }, { start: 11, end: 13, text: "Second" }];
  assert.deepEqual(alignedSubtitleCues(cues, [{ start: 11, end: 20, offset: -2 }]), cues);
  assert.deepEqual(alignedSubtitleCues(cues, [{ start: 8, end: 10, offset: 10 }]), cues);
  assert.deepEqual(alignedSubtitleCues(cues, [{ start: 0, end: 20, offset: -9 }]), cues);
});

test("dense boundary cues are trimmed while interior alignment survives", () => {
  const cues = [{ start: 1, end: 3, text: "Outside" }, { start: 10, end: 12, text: "Interior" },
    { start: 20, end: 22, text: "Tight boundary" }, { start: 22.2, end: 24, text: "Outside end" }];
  const shifted = alignedSubtitleCues(cues, [{ start: 10, end: 22, offset: 1 }]);
  assert.equal(shifted[1].start, 11);
  assert.deepEqual(shifted[2], cues[2]);
  assert.deepEqual(shifted[3], cues[3]);
  const negative = alignedSubtitleCues(cues, [{ start: 20, end: 30, offset: -2 }]);
  assert.equal(negative[2].start, 18);
  assert.equal(negative[3].start, 20.2);
  const tightStart = [{ start: 8, end: 10, text: "Outside" }, { start: 10.2, end: 12, text: "Tight" },
    { start: 20, end: 22, text: "Interior" }];
  const trimmed = alignedSubtitleCues(tightStart, [{ start: 10.2, end: 30, offset: -1 }]);
  assert.deepEqual(trimmed[1], tightStart[1]); assert.equal(trimmed[2].start, 19);
});

test("opt-in polls one job and applies a ready response once", async () => {
  const h = harness(async (_url, options) => options.method === "POST" ? { state: "working", jobId: "one" } : { state: "ready", result: correction });
  await h.controller.setEnabled(true); await flush();
  for (let i = 0; i < 10; i++) h.controller.tick(21, 900);
  assert.equal(h.requests.filter(request => request.method === "POST").length, 1);
  assert.equal(h.timers.size, 1);
  await h.poll();
  assert.deepEqual(h.changes.at(-1).corrections, [correction]);
  assert.equal(h.changes.at(-1).state, "ready");
  assert.equal(JSON.parse(h.requests.find(request => request.method === "POST").body).audioIndex, 2);
  h.controller.destroy();
});

test("switching off ignores a late result and cancels a late job", async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  await h.controller.setEnabled(true); await flush();
  await h.controller.setEnabled(false);
  finish({ state: "working", jobId: "late" }); await flush();
  assert.equal(h.changes.at(-1).enabled, false);
  assert.deepEqual(h.changes.at(-1).corrections, []);
  assert.ok(h.requests.some(request => request.method === "DELETE" && request.url.includes("late")));
  assert.equal(h.timers.size, 0);
});

test("audio changes reset corrections and require opt-in; non-English or unknown index cannot start", async () => {
  const h = harness(async () => ({ state: "ready", result: correction }));
  await h.controller.setEnabled(true); await flush();
  h.controller.setContext({ ...context, audioIndex: 3, audioLanguage: "es" });
  assert.equal(h.changes.at(-1).eligible, false);
  assert.deepEqual(h.changes.at(-1).corrections, []);
  const count = h.requests.length;
  await h.controller.setEnabled(true);
  assert.equal(h.requests.length, count);
  h.controller.setContext({ ...context, audioIndex: null });
  await h.controller.setEnabled(true); assert.equal(h.requests.length, count);
  h.controller.setContext({ ...context, audioLanguage: "" });
  assert.equal(h.changes.at(-1).eligible, true);
  h.controller.setContext({ ...context, audioLanguage: "und" });
  assert.equal(h.changes.at(-1).eligible, true);
  assert.ok(isEnglishLanguage("en-US")); assert.equal(isEnglishLanguage("es"), false);
});

test("low confidence retries a new minute only and busy uses backoff", async () => {
  let state = "insufficient";
  const h = harness(async () => ({ state }));
  await h.controller.setEnabled(true); await flush();
  h.controller.tick(25, 900); h.controller.tick(35, 900); await flush();
  assert.equal(h.requests.filter(request => request.method === "POST").length, 1);
  state = "busy"; h.controller.tick(65, 900); await flush();
  h.controller.tick(66, 900); await flush();
  assert.equal(h.requests.filter(request => request.method === "POST").length, 2);
  h.advance(10000); h.controller.tick(67, 900); await flush();
  assert.equal(h.requests.filter(request => request.method === "POST").length, 3);
  h.controller.destroy();
});

test("seek invalidates pending position and destroy prevents late corrections", async () => {
  const pending = [];
  const h = harness(async (_url, options) => options.method === "DELETE" ? { state: "stale" } : new Promise(resolve => pending.push(resolve)));
  await h.controller.setEnabled(true); await flush();
  h.controller.seek(300, 900); await flush();
  pending[0]({ state: "ready", result: correction }); await flush();
  assert.deepEqual(h.changes.at(-1).corrections, []);
  h.controller.destroy();
  pending[1]({ state: "ready", result: { ...correction, start: 300, end: 400 } }); await flush();
  assert.equal(h.changes.at(-1).enabled, false);
  assert.deepEqual(h.changes.at(-1).corrections, []);
});

test("prefetch starts near verified coverage end and only retains 32 corrections", async () => {
  const h = harness(async (_url, options) => {
    const { time } = JSON.parse(options.body);
    return { state: "ready", result: { ...correction, start: time - 10, end: time + 60 } };
  });
  await h.controller.setEnabled(true); await flush();
  h.controller.tick(30, 900); await flush();
  assert.equal(h.requests.filter(request => request.method === "POST").length, 1);
  h.controller.tick(65, 900); await flush();
  assert.equal(h.requests.filter(request => request.method === "POST").length, 2);
  for (let index = 1; index <= 40; index++) {
    h.controller.tick(index * 180, 10000); await flush();
  }
  assert.equal(h.changes.at(-1).corrections.length, 32);
  const beforeSeek = h.requests.filter(request => request.method === "POST").length;
  h.controller.seek(20, 10000); await flush();
  assert.equal(h.requests.filter(request => request.method === "POST").length, beforeSeek + 1);
  h.controller.setContext({ ...context, captions: false });
  assert.equal(h.changes.at(-1).enabled, false);
  assert.deepEqual(h.changes.at(-1).corrections, []);
});

test("local engine unavailable is actionable and does not repeatedly request jobs", async () => {
  const changes = [], requests = [];
  const controller = createSubtitleSyncController({ token: "secret", onChange: state => changes.push(state),
    fetchImpl: async url => { requests.push(url); return Response.json({ state: "unavailable" }, { status: 503 }); } });
  controller.setContext(context); controller.tick(20, 900);
  await controller.setEnabled(true);
  controller.tick(100, 900); controller.tick(300, 900);
  assert.equal(changes.at(-1).state, "unavailable");
  assert.equal(requests.length, 1);
  controller.destroy();
});

test("seeking within a pending minute cancels and retries that minute", async () => {
  const h = harness(async (_url, options) => options.method === "DELETE" ? { state: "stale" } : { state: "working", jobId: "pending" });
  await h.controller.setEnabled(true); await flush();
  h.controller.seek(30, 900); await flush();
  assert.equal(h.requests.filter(request => request.method === "POST").length, 2);
  assert.equal(h.timers.size, 1);
  h.controller.destroy();
});
