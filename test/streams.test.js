import assert from "node:assert/strict";
import test from "node:test";

import {
  StreamRegistry,
  buildStremioSourceUrl,
  decorateTorrentioStreams,
} from "../src/streams.js";

test("convierte una fuente torrent a la ruta oficial del servidor de Stremio", () => {
  const result = buildStremioSourceUrl(
    {
      infoHash: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
      fileIdx: 7,
      sources: [
        "tracker:udp://tracker.example:80/announce",
        "dht:abcdef",
      ],
    },
    "http://127.0.0.1:11470",
  );

  assert.equal(
    result,
    "http://127.0.0.1:11470/abcdef0123456789abcdef0123456789abcdef01/7?tr=tracker%3Audp%3A%2F%2Ftracker.example%3A80%2Fannounce&tr=dht%3Aabcdef",
  );
});

test("usa trackers de respaldo cuando Torrentio no entrega sources", () => {
  const result = new URL(
    buildStremioSourceUrl(
      { infoHash: "abcdef0123456789abcdef0123456789abcdef01" },
      "http://127.0.0.1:11470",
    ),
  );

  assert.equal(
    result.pathname,
    "/abcdef0123456789abcdef0123456789abcdef01/-1",
  );
  assert.deepEqual(result.searchParams.getAll("tr"), [
    "tracker:udp://tracker.opentrackr.org:1337/announce",
    "tracker:udp://open.stealth.si:80/announce",
    "tracker:udp://tracker.torrent.eu.org:451/announce",
    "dht:abcdef0123456789abcdef0123456789abcdef01",
  ]);
});

test("decora fuentes compatibles como acciones Servir en red", () => {
  const registry = new StreamRegistry({ idFactory: () => "candidate-1" });
  const streams = decorateTorrentioStreams(
    [
      {
        name: "Torrentio\n1080p",
        title: "Big Buck Bunny",
        infoHash: "abcdef0123456789abcdef0123456789abcdef01",
        fileIdx: 0,
      },
      { name: "Unsupported", ytId: "abc" },
      { name: "Invalid hash", infoHash: "not-a-hash" },
      { name: "Invalid URL", url: "file:///tmp/movie.mp4" },
    ],
    {
      activationBaseUrl: "http://127.0.0.1:17891",
      registry,
    },
  );

  assert.deepEqual(streams, [
    {
      name: "📡 Servir · Torrentio 1080p",
      description: "Big Buck Bunny\nTorrent equivalente · #abcdef01",
      externalUrl: "http://127.0.0.1:17891/activate/candidate-1",
    },
  ]);
  assert.equal(
    registry.getCandidate("candidate-1").infoHash,
    "abcdef0123456789abcdef0123456789abcdef01",
  );
});

test("limita cada respuesta a candidatos que seguirán disponibles", () => {
  let nextId = 0;
  const registry = new StreamRegistry({
    idFactory: () => `candidate-${++nextId}`,
    maxCandidates: 2,
  });
  const streams = decorateTorrentioStreams(
    [
      { url: "https://example.com/one.mp4" },
      { url: "https://example.com/two.mp4" },
      { url: "https://example.com/three.mp4" },
    ],
    {
      activationBaseUrl: "http://127.0.0.1:17891",
      registry,
    },
  );

  assert.equal(streams.length, 2);
  assert.ok(registry.getCandidate("candidate-1"));
  assert.ok(registry.getCandidate("candidate-2"));
});

test("la activación sustituye el stream servido por la URL fija", () => {
  let nextId = 0;
  const registry = new StreamRegistry({
    idFactory: () => `candidate-${++nextId}`,
  });
  const first = registry.addCandidate({ url: "https://example.com/one.mp4" });
  const second = registry.addCandidate({ url: "https://example.com/two.mp4" });

  registry.activate(first);
  assert.equal(registry.active.url, "https://example.com/one.mp4");

  registry.activate(second);
  assert.equal(registry.active.url, "https://example.com/two.mp4");
});

test("el delay conserva la versión y cambiar de fuente la renueva", () => {
  const registry = new StreamRegistry({
    idFactory: () => "candidate-1",
  });
  const id = registry.addCandidate({
    url: "https://example.com/movie.mp4",
  });
  registry.activate(id);
  registry.setSubtitles([
    {
      id: "es-1",
      language: "es",
      label: "Español",
      url: "https://example.com/es-1.srt",
    },
    {
      id: "es-2",
      language: "es",
      label: "Español",
      url: "https://example.com/es-2.srt",
    },
    {
      id: "en-1",
      language: "en",
      label: "Inglés",
      url: "https://example.com/en.srt",
    },
  ]);

  registry.setPlaybackSettings({
    subtitleLanguage: "idioma-inexistente",
    subtitleDelay: "90",
  });

  assert.deepEqual(registry.active.playbackSettings, {
    subtitleLanguage: "es",
    subtitleId: "es-1",
    subtitleSourceIndex: 0,
    subtitleDelay: 30,
  });
  assert.equal(registry.active.version, 1);

  registry.setPlaybackSettings({
    subtitleLanguage: "es",
    subtitleId: "es-2",
    subtitleDelay: "30",
  });

  assert.equal(registry.active.version, 2);
  assert.equal(registry.active.playbackSettings.subtitleId, "es-2");

  registry.setPlaybackSettings({
    subtitleLanguage: "en",
    subtitleId: "fuente-inexistente",
    subtitleDelay: "-2.5",
  });

  assert.equal(registry.active.version, 3);
  assert.deepEqual(registry.active.playbackSettings, {
    subtitleLanguage: "en",
    subtitleId: "en-1",
    subtitleSourceIndex: 0,
    subtitleDelay: -2.5,
  });
});

test("restaura idioma, número de fuente y delay al activar otro stream", () => {
  const registry = new StreamRegistry({
    idFactory: () => "candidate-1",
    playbackSettings: {
      subtitleLanguage: "es",
      subtitleId: "pista-de-otra-pelicula",
      subtitleSourceIndex: 1,
      subtitleDelay: 1.5,
    },
  });
  const id = registry.addCandidate({
    url: "https://example.com/movie.mp4",
  });

  registry.activate(id);
  registry.setSubtitles([
    {
      id: "es-1",
      language: "es",
      label: "Español",
      url: "https://example.com/es-1.srt",
    },
    {
      id: "es-2",
      language: "es",
      label: "Español",
      url: "https://example.com/es-2.srt",
    },
  ]);

  assert.deepEqual(registry.active.playbackSettings, {
    subtitleLanguage: "es",
    subtitleId: "es-2",
    subtitleSourceIndex: 1,
    subtitleDelay: 1.5,
  });
});

test("mantiene, reordena y avanza la cola de maratón", () => {
  let nextId = 0;
  const registry = new StreamRegistry({
    idFactory: () => `candidate-${++nextId}`,
    marathonSettings: {
      autoplay: true,
      countdownSeconds: 8,
      queueSize: 3,
    },
  });
  const current = registry.addCandidate({
    url: "https://example.com/current.mp4",
    unilinkContent: { type: "series", id: "tt0944947:2:1" },
  });
  const second = registry.addCandidate({
    url: "https://example.com/second.mp4",
    unilinkContent: { type: "series", id: "tt0944947:2:2" },
  });
  const third = registry.addCandidate({
    url: "https://example.com/third.mp4",
    unilinkContent: { type: "series", id: "tt0944947:2:3" },
  });
  registry.activate(current);
  registry.setMarathon({
    items: [
      {
        id: "tt0944947:2:2",
        title: "Segundo",
        season: 2,
        episode: 2,
        candidateIds: [second],
      },
      {
        id: "tt0944947:2:3",
        title: "Tercero",
        season: 2,
        episode: 3,
        candidateIds: [third],
      },
    ],
    pending: [
      {
        id: "tt0944947:2:4",
        title: "Cuarto",
        season: 2,
        episode: 4,
      },
    ],
  });

  registry.moveMarathonItem("tt0944947:2:3", -1);
  assert.deepEqual(
    registry.marathonStatus().items.map((item) => item.id),
    ["tt0944947:2:3", "tt0944947:2:2"],
  );
  assert.equal(registry.marathonStatus().canAdvance, true);
  assert.equal(registry.marathonStatus().countdownSeconds, 8);

  assert.throws(
    () => registry.advanceMarathon("tt0944947:2:2"),
    /cola ha cambiado/i,
  );
  assert.equal(registry.active.unilinkContent.id, "tt0944947:2:1");

  const active = registry.advanceMarathon("tt0944947:2:3");
  assert.equal(active.url, "https://example.com/third.mp4");
  assert.equal(active.unilinkContent.id, "tt0944947:2:3");
  assert.deepEqual(
    registry.marathonStatus().items.map((item) => item.id),
    ["tt0944947:2:2"],
  );

  assert.deepEqual(registry.takePendingMarathonVideos(1), [
    {
      id: "tt0944947:2:4",
      title: "Cuarto",
      season: 2,
      episode: 4,
    },
  ]);
  registry.removeMarathonItem("tt0944947:2:2");
  assert.equal(registry.marathonStatus().items.length, 0);
  assert.equal(registry.marathonStatus().canAdvance, false);
});
