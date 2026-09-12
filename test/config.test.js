import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConfigStore,
  normalizeMarathonSettings,
  normalizePlaybackSettings,
  normalizeTorrentioManifestUrl,
  torrentioResourceUrl,
} from "../src/config.js";

test("speech backend survives unrelated saves and rejects unknown stored values", async t => {
  const directory = await mkdtemp(join(tmpdir(), "unilink-backend-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "config.json");
  const store = new ConfigStore(path);
  for (const speechBackend of ["vulkan", "cuda", "cpu"]) {
    await store.save({ speechBackend });
    await store.save({ stremioAuthKey: "test" });
    assert.equal((await store.load()).speechBackend, speechBackend);
  }
  await store.save({ speechBackend: "unknown" });
  assert.equal((await store.load()).speechBackend, undefined);
});

test("keeps the Stremio session across settings saves and removes it on disconnect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "unilink-session-"));
  const path = join(directory, "config.json");
  const store = new ConfigStore(path);
  await store.save({ stremioAuthKey: "test-session" });
  await store.save({ torrentioManifestUrl: "https://example.com/manifest.json" });
  assert.equal((await new ConfigStore(path).load()).stremioAuthKey, "test-session");
  await store.save({ stremioAuthKey: null });
  assert.doesNotMatch(await readFile(path, "utf8"), /test-session|stremioAuthKey/);
  assert.equal((await store.load()).torrentioManifestUrl, "https://example.com/manifest.json");
});

test("normaliza una URL de instalación de Torrentio", () => {
  assert.equal(
    normalizeTorrentioManifestUrl(
      "stremio://torrentio.strem.fun/providers=yts/manifest.json",
    ),
    "https://torrentio.strem.fun/providers=yts/manifest.json",
  );
});

test("rechaza URLs que no sean HTTP(S) o no terminen en manifest.json", () => {
  assert.throws(
    () => normalizeTorrentioManifestUrl("file:///tmp/manifest.json"),
    /HTTP o HTTPS/,
  );
  assert.throws(
    () => normalizeTorrentioManifestUrl("https://example.com/configure"),
    /manifest\.json/,
  );
});

test("construye el endpoint de streams conservando la configuración", () => {
  assert.equal(
    torrentioResourceUrl(
      "https://torrentio.strem.fun/providers=yts/manifest.json",
      "movie",
      "tt1254207",
    ),
    "https://torrentio.strem.fun/providers=yts/stream/movie/tt1254207.json",
  );
});

test("normaliza los ajustes de maratón dentro de límites seguros", () => {
  assert.deepEqual(
    normalizeMarathonSettings({
      autoplay: false,
      countdownSeconds: 99,
      queueSize: 0,
    }),
    {
      autoplay: false,
      countdownSeconds: 30,
      queueSize: 1,
    },
  );
  assert.deepEqual(normalizeMarathonSettings(), {
    autoplay: true,
    countdownSeconds: 10,
    queueSize: 5,
  });
});

test("normaliza el delay de subtítulos en pasos de 0,05 dentro de sus límites", () => {
  assert.equal(
    normalizePlaybackSettings({ subtitleDelay: 0.30000000000000004 })
      .subtitleDelay,
    0.3,
  );
  assert.equal(
    normalizePlaybackSettings({ subtitleDelay: 30.5 }).subtitleDelay,
    30,
  );
  assert.equal(
    normalizePlaybackSettings({ subtitleDelay: -30.5 }).subtitleDelay,
    -30,
  );
  assert.equal(
    normalizePlaybackSettings({ subtitleDelay: 0.07 }).subtitleDelay,
    0.05,
  );
});

test("serializa escrituras para que el último ajuste gane", async () => {
  const store = new ConfigStore("unused.json");
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  store.write = async ({ marker }) => {
    order.push(`start-${marker}`);
    if (marker === "first") {
      await firstGate;
    }
    order.push(`end-${marker}`);
    return marker;
  };

  const first = store.save({ marker: "first" });
  await new Promise((resolve) => setImmediate(resolve));
  const second = store.save({ marker: "second" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["start-first"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, [
    "start-first",
    "end-first",
    "start-second",
    "end-second",
  ]);
});

test("persiste la configuración de forma atómica", async () => {
  const directory = await mkdtemp(join(tmpdir(), "unilink-config-"));
  const path = join(directory, "config.json");
  const store = new ConfigStore(path);

  await store.save({
    torrentioManifestUrl: "https://torrentio.strem.fun/manifest.json",
    playbackSettings: {
      subtitleLanguage: "es",
      subtitleId: "subtitle-es-2",
      subtitleSourceIndex: 1,
      subtitleDelay: 1.5,
    },
    marathonSettings: {
      autoplay: false,
      countdownSeconds: 12,
      queueSize: 4,
    },
  });

  assert.deepEqual(await store.load(), {
    torrentioManifestUrl: "https://torrentio.strem.fun/manifest.json",
    playbackSettings: {
      subtitleLanguage: "es",
      subtitleId: "subtitle-es-2",
      subtitleSourceIndex: 1,
      subtitleDelay: 1.5,
    },
    marathonSettings: {
      autoplay: false,
      countdownSeconds: 12,
      queueSize: 4,
    },
  });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    torrentioManifestUrl: "https://torrentio.strem.fun/manifest.json",
    playbackSettings: {
      subtitleLanguage: "es",
      subtitleId: "subtitle-es-2",
      subtitleSourceIndex: 1,
      subtitleDelay: 1.5,
    },
    marathonSettings: {
      autoplay: false,
      countdownSeconds: 12,
      queueSize: 4,
    },
  });

  await store.save({
    torrentioManifestUrl:
      "https://torrentio.strem.fun/providers=yts/manifest.json",
  });
  assert.deepEqual(await store.load(), {
    torrentioManifestUrl:
      "https://torrentio.strem.fun/providers=yts/manifest.json",
    playbackSettings: {
      subtitleLanguage: "es",
      subtitleId: "subtitle-es-2",
      subtitleSourceIndex: 1,
      subtitleDelay: 1.5,
    },
    marathonSettings: {
      autoplay: false,
      countdownSeconds: 12,
      queueSize: 4,
    },
  });
});
