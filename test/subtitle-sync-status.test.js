import assert from "node:assert/strict";
import test from "node:test";
import { SubtitleSyncStatus } from "../src/subtitle-sync-status.js";

const report = (overrides = {}) => ({ clientId: "tv", sequence: 1, enabled: true,
  state: "ready", automaticOffset: 1.458, manualBaseline: -2, time: 100, ...overrides });

test("live timing separates automatic correction from manual fine-tuning without persisting either", () => {
  const store = new SubtitleSyncStatus();
  const active = { playbackSettings: { subtitleDelay: -2 } };
  assert.equal(store.record(active, "/captions/en", report()), true);
  assert.equal(store.get(active, "/captions/en").effectiveDelay, 1.458);
  assert.equal(store.get(active, "/captions/en").manualAdjustment, 0);
  active.playbackSettings.subtitleDelay = -1.95;
  assert.ok(Math.abs(store.get(active, "/captions/en").effectiveDelay - 1.508) < 1e-9);
  assert.equal(active.playbackSettings.subtitleDelay, -1.95);
  store.record(active, "/captions/en", report({ sequence: 2, enabled: false, state: "off" }));
  assert.equal(store.get(active, "/captions/en").effectiveDelay, -1.95);
  assert.equal(store.get(active, "/captions/en").automaticOffset, 0);
});

test("old, expired and different-source reports cannot replace live timing", () => {
  let time = 1000;
  const store = new SubtitleSyncStatus({ now: () => time });
  const active = { playbackSettings: { subtitleDelay: 0 } };
  store.record(active, "en", report({ sequence: 2 }));
  assert.equal(store.record(active, "en", report({ automaticOffset: 50 })), false);
  assert.equal(store.get(active, "en").automaticOffset, 1.458);
  assert.equal(store.get({}, "en"), null);
  assert.equal(store.get(active, "es"), null);
  store.record(active, "en", report({ sequence: 3 }));
  assert.ok(store.get(active, "en"));
  time += 15001;
  assert.equal(store.get(active, "en"), null);
});

test("latest viewer wins, with bounded per-viewer ordering state", () => {
  const store = new SubtitleSyncStatus();
  const active = {};
  for (let index = 0; index < 40; index++) store.record(active, "en", report({ clientId: `tv-${index}` }));
  assert.equal(store.get(active, "en").automaticOffset, 1.458);
  assert.ok(store.reports.size <= 32);
});
