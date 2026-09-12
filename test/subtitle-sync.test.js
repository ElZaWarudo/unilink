import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SubtitleSync, validCorrection } from "../src/subtitle-sync.js";
import { createUnilinkServer } from "../src/server.js";
import { StreamRegistry } from "../src/streams.js";
import { createSubtitleSyncController } from "../src/player.js";

const result = { start: 100, end: 150, offset: 1.5, anchors: 9, residual: .15 };
const context = overrides => ({ key: "source-en-track0-100", isCurrent: () => true,
  prepare: async () => ({ subtitles: "WEBVTT", audioIndex: 0 }), window: { start: 100, duration: 120 }, ...overrides });
async function completed(sync, id) {
  for (let i = 0; i < 100; i++) {
    const status = sync.get(id);
    if (status.state !== "working") return status;
    await delay(5);
  }
  assert.fail("Job did not complete");
}

test("validates bounded correction protocol instead of trusting worker output", () => {
  const window = { start: 100, duration: 120 };
  assert.equal(validCorrection(result, window), true);
  for (const invalid of [{ ...result, offset: 50 }, { ...result, anchors: 2 }, { ...result, start: -10 },
    { ...result, end: 1000 }, { ...result, residual: NaN }]) assert.equal(validCorrection(invalid, window), false);
});

test("release waits for service close, deduplicates and blocks new jobs until replacement", async () => {
  const sync = new SubtitleSync();
  let finishClose, closes = 0;
  const oldService = { close: () => { closes++; return new Promise(resolve => { finishClose = resolve; }); } };
  sync.service = oldService;
  let released = false;
  const release = sync.release();
  release.then(() => { released = true; });
  assert.equal(sync.release(), release);
  assert.equal(closes, 1);
  assert.equal(sync.start(context()).state, "busy");
  await delay(0);
  assert.equal(released, false);
  assert.equal(sync.service, oldService);
  finishClose();
  await release;
  assert.notEqual(sync.service, oldService);
  await sync.close();
});

test("close during release prevents recreation and failed release can be retried", async () => {
  const sync = new SubtitleSync();
  let finishClose, failClose, closes = 0;
  const oldService = { close: () => { closes++; return new Promise((resolve, reject) => {
    finishClose = resolve; failClose = reject;
  }); } };
  sync.service = oldService;
  const release = sync.release();
  failClose(new Error('termination unconfirmed'));
  await assert.rejects(release, /termination unconfirmed/);
  assert.equal(sync.service, oldService);
  const retry = sync.release();
  assert.equal(sync.close(), retry);
  assert.equal(sync.start(context()).state, "unavailable");
  finishClose();
  await retry;
  assert.equal(closes, 2);
  assert.equal(sync.service, oldService);
});

test("changing backend waits for owned service exit and clears previous correction cache", async () => {
  const sync = new SubtitleSync({ run: async () => ({ state: 'ready', result,
    metrics: { backend: 'cpu' } }), paths: { backend: 'cpu' } });
  const first = sync.start(context());
  assert.equal((await completed(sync, first.jobId)).state, 'ready');
  let finish;
  const old = { close: () => new Promise(resolve => { finish = resolve; }) };
  sync.service = old;
  const change = sync.setBackend('vulkan');
  assert.equal(sync.start(context()).state, 'busy');
  assert.equal(sync.paths.backend, 'cpu');
  finish();
  await change;
  assert.notEqual(sync.service, old);
  assert.equal(sync.service.paths.backend, 'vulkan');
  assert.equal(sync.backendStatus(), null);
  const next = sync.start(context());
  assert.notEqual(next.jobId, first.jobId);
  assert.equal((await completed(sync, next.jobId)).state, 'ready');
  await sync.close();
});

test("deduplicates same window, limits concurrency, and caches by source/track", async () => {
  let release, calls = 0;
  const sync = new SubtitleSync({ maxConcurrent: 1, run: async () => { calls++; return new Promise(r => { release = r; }); } });
  const first = sync.start(context());
  assert.equal(sync.start(context()).jobId, first.jobId);
  assert.equal(sync.start(context({ key: "different-audio" })).state, "busy");
  await delay(0);
  release({ state: "ready", result });
  assert.equal((await completed(sync, first.jobId)).state, "ready");
  assert.equal(sync.start(context()).jobId, first.jobId);
  assert.equal(calls, 1);
  sync.close();
});

test("accepts two bounded jobs and reports worker progress without mixing results", async () => {
  const finishes = [];
  const sync = new SubtitleSync({ run: (_input, _signal, progress) => {
    progress('recognizing');
    return new Promise(resolve => finishes.push(resolve));
  } });
  const first = sync.start(context());
  const second = sync.start(context({key:'second'}));
  assert.equal(second.state,'working');
  assert.equal(sync.start(context({key:'third'})).state,'busy');
  await delay(0);
  assert.equal(sync.get(first.jobId).stage,'recognizing');
  finishes[1]({state:'insufficient'});
  assert.equal((await completed(sync,second.jobId)).state,'insufficient');
  assert.equal(sync.get(first.jobId).state,'working');
  finishes[0]({state:'ready',result});
  assert.equal((await completed(sync,first.jobId)).state,'ready');
  await sync.close();
});

test("source changes discard an in-flight result", async () => {
  let release, current = true;
  const sync = new SubtitleSync({ run: () => new Promise(r => { release = r; }) });
  const job = sync.start(context({ isCurrent: () => current }));
  await delay(0);
  current = false;
  release({ state: "ready", result });
  await delay(0);
  assert.equal(sync.get(job.jobId).state, "stale");
  assert.equal(sync.active, null);
});

test("late response cancellation cannot cancel the new seek generation's job", async t => {
  const flush = () => new Promise(resolve => setImmediate(resolve));
  let releaseFirst, finishRecognition, posts = 0, latest;
  const timers = new Map();
  let timerId = 0;
  const sync = new SubtitleSync({ maxConcurrent: 1, run: (_, signal) => new Promise((resolve, reject) => {
    finishRecognition = resolve;
    signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  }) });
  const controller = createSubtitleSyncController({ token: "test",
    setTimer(fn) { timers.set(++timerId, fn); return timerId; }, clearTimer(id) { timers.delete(id); },
    onChange(value) { latest = value; },
    fetchImpl: async (url, options) => {
      const id = new URL(url, "http://test").searchParams.get("job");
      if (options.method === "DELETE") return Response.json(sync.cancel(id));
      if (!options.method) return Response.json(id ? sync.get(id) : { available: true });
      const { requestId } = JSON.parse(options.body);
      const response = sync.start(context({ requestId }));
      if (++posts === 1) await new Promise(resolve => { releaseFirst = resolve; });
      return Response.json(response);
    },
  });
  t.after(() => { controller.destroy(); sync.close(); });
  controller.setContext({ captions: true, subtitleLanguage: "en", audioLanguage: "en", audioIndex: 0 });
  controller.tick(125, 900);
  await controller.setEnabled(true); await flush();
  controller.seek(130, 900); await flush();
  assert.equal(latest.state, "busy");
  releaseFirst(); await flush();
  assert.equal(sync.active, null);
  const [retryId, retry] = timers.entries().next().value;
  timers.delete(retryId); retry(); await flush();
  assert.equal(posts, 3);
  finishRecognition({ state: "ready", result }); await flush();
  const [id, poll] = timers.entries().next().value;
  timers.delete(id); poll(); await flush();
  assert.equal(latest.state, "ready");
  assert.deepEqual(latest.corrections, [result]);
});

test("cancellation and deadline abort worker and allow later jobs", async () => {
  let aborted = 0;
  const sync = new SubtitleSync({ timeoutMs: 30, run: (_, signal) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => { aborted++; reject(new Error("stopped")); });
  }) });
  const job = sync.start(context());
  assert.equal((await completed(sync, job.jobId)).state, "error");
  assert.equal(aborted, 1);
  await delay(0);
  const next = sync.start(context({ key: "next" }));
  await delay(0);
  sync.cancel(next.jobId);
  await delay(0);
  assert.equal(sync.get(next.jobId).state, "cancelled");
  assert.equal(aborted, 2);
  assert.equal(sync.active, null);
});

test("low confidence and invalid worker data never become a correction", async () => {
  for (const output of [{ state: "insufficient" }, { state: "ready", result: { ...result, offset: Infinity } }]) {
    const sync = new SubtitleSync({ run: async () => output });
    const job = sync.start(context());
    const status = await completed(sync, job.jobId);
    assert.notEqual(status.state, "ready");
    assert.equal(status.result, undefined);
  }
});

test("HTTP flow binds English subtitles and selected HLS audio, rejects CSRF/stale players", async t => {
  const registry = new StreamRegistry();
  registry.activate(registry.addCandidate({ url: "https://example.com/video.mkv" }));
  registry.setSubtitles([{ id: "english", language: "en", label: "English", url: "https://example.com/sub.vtt" }]);
  const inputs = [];
  const sync = new SubtitleSync({ available: async () => true, run: async input => {
    inputs.push(input); return { state: "ready", result: { ...result, start: 110, end: 150 } };
  } });
  const server = createUnilinkServer({ registry, subtitleSync: sync,
    configStore: { load: async () => ({}) }, activationBaseUrl: "http://127.0.0.1",
    fetchImpl: async url => {
      if (String(url).includes("/hlsv2/")) return new Response('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",URI="audio2.m3u8"\nvideo0.m3u8');
      if (String(url).includes("/subtitles.vtt")) return new Response("WEBVTT\n\n00:01.000 --> 00:02.000\nHello there.");
      throw new Error("Unexpected upstream");
    } });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(base + "/watch")).text();
  const token = html.match(/data-progress-token="([^"]+)"/)[1];
  const status = await (await fetch(base + "/api/status")).json();
  const headers = { "x-unilink-token": token, "content-type": "application/json" };
  const body = { serverInstanceId: status.serverInstanceId, version: status.version,
    subtitleUrl: status.subtitleUrl, audioIndex: 0, time: 125, duration: 2700 };
  const post = (changes = {}, extraHeaders = {}) => fetch(base + "/api/subtitle-sync", {
    method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify({ ...body, ...changes }),
  });
  assert.equal((await post({}, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post({}, { "x-unilink-token": "bad" })).status, 403);
  assert.equal((await post({ version: -1 })).status, 409);
  assert.equal((await post({ audioIndex: -1 })).status, 400);
  assert.equal((await post({ subtitleUrl: "https://evil.example/file" })).status, 409);
  const response = await post();
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const job = await response.json();
  assert.equal((await completed(sync, job.jobId)).state, "ready");
  assert.equal(inputs[0].audioIndex, 2);
  assert.match(inputs[0].mediaUrl, /\/media\?instance=.*&version=/);
  assert.match(inputs[0].subtitles, /^WEBVTT/);
  registry.setSubtitles([{ id: "spanish", language: "es", label: "Español", url: "https://example.com/es.vtt" }]);
  assert.equal((await post()).status, 422);
});
