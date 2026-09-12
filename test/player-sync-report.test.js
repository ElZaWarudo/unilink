import assert from "node:assert/strict";
import test from "node:test";
import { alignedSubtitleCues, appliedSubtitleOffset, createSubtitleSyncReporter } from "../src/player.js";

const flush = () => new Promise(resolve => setImmediate(resolve));
const snapshot = { serverInstanceId: "server", version: 1, subtitleUrl: "/sub.vtt", enabled: true,
  state: "ready", automaticOffset: 1.46, manualBaseline: -2, time: 25 };

test("reporter coalesces live changes, retries heartbeat failures and sends final off", async () => {
  const timers = new Map(), reports = [], pending = [];
  let value = { ...snapshot }, id = 0;
  const reporter = createSubtitleSyncReporter({ token: "secret", getSnapshot: () => value,
    setTimer(fn) { timers.set(++id, fn); return id; }, clearTimer(key) { timers.delete(key); },
    fetchImpl: (url, options) => {
      assert.equal(url, "/api/subtitle-sync/playback");
      assert.equal(options.headers["x-unilink-token"], "secret");
      reports.push(JSON.parse(options.body));
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    } });
  reporter.report();
  value = { ...value, time: 26 }; reporter.report();
  value = { ...value, time: 27 }; reporter.report();
  assert.equal(reports.length, 1);
  pending.shift().resolve(Response.json({})); await flush();
  assert.equal(reports.length, 2); assert.equal(reports[1].time, 27);
  pending.shift().reject(Error("offline")); await flush();
  assert.equal(reports.length, 2, "failed delivery must not spin");
  const [key, heartbeat] = timers.entries().next().value; timers.delete(key); heartbeat();
  assert.equal(reports.length, 3);
  reporter.destroy(); assert.equal(timers.size, 0);
  pending.shift().resolve(Response.json({})); await flush();
  assert.equal(reports.at(-1).enabled, false);
  assert.equal(reports.at(-1).manualBaseline, 0);
  assert.equal(reports.at(-1).automaticOffset, 0);
  assert.deepEqual(reports.map(item => item.sequence), [1, 2, 3, 4]);
  assert.equal(new Set(reports.map(item => item.clientId)).size, 1);
  pending.shift().resolve(Response.json({})); await flush();
  reporter.report(); assert.equal(reports.length, 4);
});

test("reporter captures context per send and stops rejected stale sessions", async () => {
  let value = { ...snapshot }; const reports = [];
  const reporter = createSubtitleSyncReporter({ token: "secret", getSnapshot: () => value,
    setTimer: () => 1, clearTimer() {}, fetchImpl: async (_url, options) => {
      reports.push(JSON.parse(options.body)); return Response.json({}, { status: reports.length === 2 ? 409 : 200 });
    } });
  reporter.report(); await flush();
  value = { ...snapshot, subtitleUrl: "/new.vtt" }; reporter.report(); await flush();
  assert.equal(reports[0].subtitleUrl, "/sub.vtt"); assert.equal(reports[1].subtitleUrl, "/new.vtt");
  reporter.report(); assert.equal(reports.length, 2);
  value = { ...value, subtitleUrl: "/third.vtt" }; reporter.report(); await flush();
  assert.equal(reports.length, 3, "a subtitle context change permits fresh reports");
  reporter.destroy();
});

test("no progress token creates neither requests nor heartbeat", () => {
  const reporter = createSubtitleSyncReporter({ token: "", getSnapshot: () => snapshot,
    fetchImpl() { assert.fail("unexpected request"); }, setTimer() { assert.fail("unexpected timer"); } });
  reporter.report(); reporter.destroy();
});

test("returning to a rejected subtitle track starts a fresh reporting context", async () => {
  let value = { ...snapshot }; const reports = [];
  const reporter = createSubtitleSyncReporter({ token: "secret", getSnapshot: () => value,
    setTimer: () => 1, clearTimer() {}, fetchImpl: async (_url, options) => {
      reports.push(JSON.parse(options.body));
      return Response.json({}, { status: reports.length === 1 ? 409 : 200 });
    } });
  reporter.report(); await flush();
  reporter.report(); assert.equal(reports.length, 1);
  value = { ...snapshot, subtitleUrl: "/other.vtt" }; reporter.report(); await flush();
  value = { ...snapshot }; reporter.report(); await flush();
  assert.deepEqual(reports.map(item => item.subtitleUrl), ["/sub.vtt", "/other.vtt", "/sub.vtt"]);
  reporter.destroy();
});

test("a delayed rejection cannot suppress a newer visit to the same track", async () => {
  let value = { ...snapshot }; const reports = [], replies = [];
  const reporter = createSubtitleSyncReporter({ token: "secret", getSnapshot: () => value,
    setTimer: () => 1, clearTimer() {}, fetchImpl: (_url, options) => {
      reports.push(JSON.parse(options.body)); return new Promise(resolve => replies.push(resolve));
    } });
  reporter.report();
  value = { ...snapshot, subtitleUrl: "/other.vtt" }; reporter.report();
  value = { ...snapshot }; reporter.report();
  replies.shift()(Response.json({}, { status: 409 })); await flush();
  assert.equal(reports.length, 2);
  assert.equal(reports[1].subtitleUrl, "/sub.vtt");
  replies.shift()(Response.json({})); await flush();
  reporter.report(); assert.equal(reports.length, 3);
  replies.shift()(Response.json({})); await flush();
  reporter.destroy(); replies.shift()(Response.json({})); await flush();
});

test("reported automatic correction follows rendered boundary cues and excludes manual adjustment", () => {
  const cues = [{ start: 10, end: 12, text: "Interior" }, { start: 20, end: 22, text: "Boundary" },
    { start: 22.2, end: 24, text: "Outside" }];
  const corrections = [{ start: 10, end: 22, offset: 1 }];
  const shifted = alignedSubtitleCues(cues, corrections);
  assert.equal(appliedSubtitleOffset(cues, shifted, corrections, 11.5, 0), 1);
  assert.equal(appliedSubtitleOffset(cues, shifted, corrections, 12, 0.5), 1);
  assert.equal(appliedSubtitleOffset(cues, shifted, corrections, 21, 0), 0);
  assert.equal(appliedSubtitleOffset(cues, shifted, corrections, 16, 0), 1);
  assert.equal(appliedSubtitleOffset(cues, shifted, corrections, 50, 0), 0);
});
