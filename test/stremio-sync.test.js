import assert from "node:assert/strict";
import test from "node:test";
import { StremioSync } from "../src/stremio-sync.js";

function fixture(fetchImpl) {
  let config = { stremioAuthKey: "test-session" };
  const configStore = {
    load: async () => ({ ...config }),
    save: async (patch) => { config = { ...config, ...patch }; },
  };
  return { sync: new StremioSync({ configStore, fetchImpl }), configStore };
}
const active = { version: 1, unilinkContent: { type: "series", id: "tt123:2:3" } };

test("browser progress reaches the Stremio library in milliseconds without losing watch history", async () => {
  let written;
  const existing = { _id: "tt123", type: "series", name: "Series", removed: false,
    state: { video_id: "tt123:2:2", timeOffset: 9000, watched: "existing-history", noNotif: true } };
  const { sync } = fixture(async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.authKey, "test-session");
    assert.equal(body.collection, "libraryItem");
    if (url.endsWith("datastoreGet")) {
      assert.deepEqual(body.ids, ["tt123"]);
      return Response.json({ result: [existing] });
    }
    written = body.changes[0];
    return Response.json({ result: { success: true } });
  });
  assert.deepEqual(await sync.report(active, { time: 125.5, duration: 1800 }), { state: "synced" });
  assert.equal(written.state.timeOffset, 125500);
  assert.equal(written.state.duration, 1800000);
  assert.equal(written.state.video_id, "tt123:2:3");
  assert.equal(written.state.watched, "existing-history");
  assert.equal(written.state.noNotif, true);
  assert.equal(written.removed, false);
});

test("failed reads never replace existing library data with a new item and can be retried", async () => {
  let fail = true;
  let puts = 0;
  const { sync } = fixture(async (url) => {
    if (url.endsWith("datastoreGet")) {
      if (fail) throw new Error("network error with test-session");
      return Response.json({ result: [{ _id: "tt123", state: {} }] });
    }
    puts++;
    return Response.json({ result: { success: true } });
  });
  assert.deepEqual(await sync.report(active, { time: 30, duration: 1800 }), { state: "error" });
  assert.equal(puts, 0);
  fail = false;
  assert.deepEqual(await sync.report(active, { time: 45, duration: 1800 }), { state: "synced" });
  assert.equal(puts, 1);
});

test("invalid progress and disconnected accounts never call Stremio", async () => {
  const { sync, configStore } = fixture(() => { throw new Error("unexpected request"); });
  assert.deepEqual(await sync.report(active, { time: NaN, duration: 30 }), { state: "invalid" });
  await configStore.save({ stremioAuthKey: null });
  assert.deepEqual(await sync.report(active, { time: 10, duration: 30 }), { state: "disconnected" });
});

test("one-time linking persists the key on the server and never returns it to the browser", async () => {
  let linked = false;
  const { sync, configStore } = fixture(async (url) => {
    if (url.includes("/create")) return Response.json({ result: { code: "test-code", link: "https://link.stremio.com/ABCD" } });
    return Response.json(linked ? { result: { authKey: "new-test-session" } } : { error: { code: 101 } });
  });
  await configStore.save({ stremioAuthKey: null });
  const result = await sync.connect();
  assert.equal(result.link, "https://link.stremio.com/ABCD");
  assert.deepEqual(await sync.pollLink(), { state: "pending" });
  linked = true;
  assert.deepEqual(await sync.pollLink(), { state: "connected" });
  assert.equal((await configStore.load()).stremioAuthKey, "new-test-session");
  await sync.disconnect();
  assert.equal((await configStore.load()).stremioAuthKey, null);
});

test("new external playback creates a temporary Continue Watching item with metadata", async () => {
  let written;
  const { sync } = fixture(async (url, options) => {
    if (url.endsWith("datastoreGet")) return Response.json({ result: [] });
    if (url.includes("/meta/")) return Response.json({ meta: { id: "tt123", name: "Movie" } });
    written = JSON.parse(options.body).changes[0];
    return Response.json({ result: { success: true } });
  });
  await sync.report({ unilinkContent: { type: "movie", id: "tt123" } }, { time: 30, duration: 120 });
  assert.equal(written.name, "Movie");
  assert.equal(written.temp, true);
  assert.equal(written.removed, true);
  assert.equal(written.state.timeOffset, 30000);
});

test("disconnect while linking is in flight cannot reconnect the account", async () => {
  let finish;
  const { sync, configStore } = fixture(async url => {
    if (url.includes("/create")) return Response.json({ result: { code: "test-code", link: "https://link.stremio.com/TEST" } });
    return new Promise(resolve => { finish = resolve; });
  });
  await configStore.save({ stremioAuthKey: null });
  await sync.connect();
  const polling = sync.pollLink();
  await sync.disconnect();
  finish(Response.json({ result: { authKey: "stale-test-session" } }));
  assert.deepEqual(await polling, { state: "disconnected" });
  assert.equal((await configStore.load()).stremioAuthKey, null);
});

test("a source change while reading the library prevents the old position from being written", async () => {
  let writes = 0;
  const { sync } = fixture(async url => {
    if (url.endsWith("datastoreGet")) return Response.json({ result: [{ _id: "tt123", state: {} }] });
    writes++;
    return Response.json({ result: { success: true } });
  });
  assert.deepEqual(await sync.report(active, { time: 20, duration: 1800 }, () => false), { state: "stale" });
  assert.equal(writes, 0);
});

test("resuming a removed title restores Continue Watching visibility without adding it to the library", async () => {
  let written;
  const { sync } = fixture(async (url, options) => {
    if (url.endsWith("datastoreGet")) return Response.json({ result: [{ _id: "tt123", removed: true, temp: false, state: {} }] });
    written = JSON.parse(options.body).changes[0];
    return Response.json({ result: { success: true } });
  });
  await sync.report(active, { time: 60, duration: 1800 });
  assert.equal(written.removed, true);
  assert.equal(written.temp, true);
});

test("a final keepalive update is retained while a previous write is in flight", async () => {
  let releaseFirst;
  let firstStarted;
  let finalWritten;
  const first = new Promise(resolve => { firstStarted = resolve; });
  const done = new Promise(resolve => { finalWritten = resolve; });
  const positions = [];
  const { sync } = fixture(async (url, options) => {
    if (url.endsWith("datastoreGet")) return Response.json({ result: [{ _id: "tt123", state: {} }] });
    const time = JSON.parse(options.body).changes[0].state.timeOffset;
    positions.push(time);
    if (positions.length === 1) {
      firstStarted();
      await new Promise(resolve => { releaseFirst = resolve; });
    } else finalWritten();
    return Response.json({ result: { success: true } });
  });
  const initial = sync.report(active, { time: 10, duration: 1800 });
  await first;
  assert.deepEqual(await sync.report(active, { time: 12, duration: 1800 }), { state: "pending" });
  assert.deepEqual(await sync.report(active, { time: 15, duration: 1800 }), { state: "pending" });
  releaseFirst();
  await initial;
  await done;
  assert.deepEqual(positions, [10000, 15000]);
});

test("unsupported content and disconnected accounts do not claim pending cloud progress", async () => {
  const { sync, configStore } = fixture(() => { throw new Error("unexpected request"); });
  sync.busy = true;
  assert.deepEqual(await sync.report({ unilinkContent: { type: "movie", id: "custom-source" } }, { time: 1, duration: 60 }), { state: "unsupported" });
  assert.deepEqual(await sync.report({}, { time: NaN, duration: 60 }), { state: "invalid" });
  await configStore.save({ stremioAuthKey: null });
  assert.deepEqual(await sync.report(active, { time: 1, duration: 60 }), { state: "disconnected" });
  assert.equal(sync.pendingReport, undefined);
});
