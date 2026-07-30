import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConfigStore,
  normalizeMarathonSettings,
  normalizeTorrentioManifestUrl,
  torrentioResourceUrl,
} from "../src/config.js";

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
