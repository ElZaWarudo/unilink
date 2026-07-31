import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigStore } from "../src/config.js";
import { createUnilinkServer } from "../src/server.js";
import { StreamRegistry } from "../src/streams.js";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "unilink-server-"));
  let nextCandidateId = 0;
  const {
    configStore = new ConfigStore(join(directory, "config.json")),
    registry = new StreamRegistry({
      idFactory: () => `candidate-${++nextCandidateId}`,
    }),
    ...serverOptions
  } = options;
  const server = createUnilinkServer({
    configStore,
    registry,
    activationBaseUrl: "http://127.0.0.1:17891",
    ...serverOptions,
  });
  const baseUrl = await listen(server);
  return {
    baseUrl,
    configStore,
    registry,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("expone un manifest instalable y CORS", async (t) => {
  const app = await fixture();
  t.after(app.close);

  const response = await fetch(`${app.baseUrl}/manifest.json`);
  const manifest = await response.json();

  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(
    Number(response.headers.get("content-length")),
    Buffer.byteLength(JSON.stringify(manifest)),
  );
  assert.equal(manifest.id, "community.unilink.local");
  assert.deepEqual(manifest.resources, ["stream"]);
  assert.deepEqual(manifest.types, ["movie", "series"]);
  assert.equal(manifest.configurable, true);
});

test("cada arranque expone una identidad distinta", async (t) => {
  const first = await fixture();
  const second = await fixture();
  t.after(first.close);
  t.after(second.close);

  const firstStatus = await fetch(`${first.baseUrl}/api/status`).then(
    (response) => response.json(),
  );
  const secondStatus = await fetch(`${second.baseUrl}/api/status`).then(
    (response) => response.json(),
  );

  assert.equal(firstStatus.version, secondStatus.version);
  assert.notEqual(
    firstStatus.serverInstanceId,
    secondStatus.serverInstanceId,
  );
  assert.equal(firstStatus.watchUrl, "http://127.0.0.1:17891/watch");
});

test("configura el delay solo desde el host y sirve un reproductor autocontenido", async (t) => {
  const registry = new StreamRegistry({ idFactory: () => "candidate-1" });
  const candidate = registry.addCandidate({
    url: "https://example.com/movie.mp4",
  });
  registry.activate(candidate);
  registry.setSubtitles([
    {
      id: "es-1",
      language: "es",
      label: "Español",
      url: "https://example.com/es.srt",
    },
  ]);
  const app = await fixture({ registry });
  t.after(app.close);
  const watchHtml = await fetch(`${app.baseUrl}/watch`).then((response) =>
    response.text(),
  );
  assert.doesNotMatch(watchHtml, /data-subtitle-sync/);

  const settings = await fetch(`${app.baseUrl}/settings`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "subtitleLanguage=es&subtitleId=es-1&subtitleDelay=0.05",
  });
  const settingsHtml = await settings.text();
  assert.equal(settings.status, 200);
  assert.match(settingsHtml, /data-subtitle-delay-stepper/);
  assert.match(settingsHtml, /data-subtitle-delay-change="-0.05"/);
  assert.match(settingsHtml, /data-subtitle-delay-change="0.05"/);
  assert.match(settingsHtml, /data-subtitle-delay-reset/);
  assert.match(settingsHtml, /name="subtitleDelay" type="hidden"/);
  assert.equal(
    (await app.configStore.load()).playbackSettings.subtitleDelay,
    0.05,
  );

  const playerScript = await fetch(`${app.baseUrl}/player.js`).then(
    (response) => response.text(),
  );
  assert.doesNotMatch(playerScript, /^import\s/m);
});

test("devuelve una explicación cuando Torrentio aún no está configurado", async (t) => {
  const app = await fixture();
  t.after(app.close);

  const response = await fetch(`${app.baseUrl}/stream/movie/tt1254207.json`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.streams, []);
  assert.match(response.headers.get("x-unilink-warning"), /configura Torrentio/i);
});

test("consulta Torrentio y publica acciones de activación", async (t) => {
  let requestedUrl;
  const app = await fixture({
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return Response.json({
        streams: [
          {
            name: "Torrentio 1080p",
            infoHash: "abcdef0123456789abcdef0123456789abcdef01",
            fileIdx: 2,
          },
        ],
      });
    },
  });
  t.after(app.close);
  await app.configStore.save({
    torrentioManifestUrl:
      "https://torrentio.strem.fun/providers=yts/manifest.json",
  });

  const response = await fetch(`${app.baseUrl}/stream/movie/tt1254207.json`);
  const body = await response.json();

  assert.equal(
    requestedUrl,
    "https://torrentio.strem.fun/providers=yts/stream/movie/tt1254207.json",
  );
  assert.equal(
    body.streams[0].externalUrl,
    "http://127.0.0.1:17891/activate/candidate-1",
  );
});

test("si Torrentio falla mantiene el contrato JSON del addon", async (t) => {
  const app = await fixture({
    fetchImpl: async () => new Response("upstream error", { status: 503 }),
  });
  t.after(app.close);
  await app.configStore.save({
    torrentioManifestUrl: "https://torrentio.strem.fun/manifest.json",
  });

  const response = await fetch(`${app.baseUrl}/stream/movie/tt1254207.json`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { streams: [] });
  assert.match(response.headers.get("x-unilink-warning"), /HTTP 503/);
});

test("activa una fuente y la página fija contiene un reproductor", async (t) => {
  const app = await fixture();
  t.after(app.close);
  const id = app.registry.addCandidate({
    url: "https://example.com/movie.mp4",
    name: "Torrentio 720p",
    description: "Película de prueba\n👤 13 💾 866 MB ⚙️ YTS",
  });

  const activation = await fetch(`${app.baseUrl}/activate/${id}`);
  assert.equal(activation.status, 200);

  const watch = await fetch(`${app.baseUrl}/watch`);
  const html = await watch.text();
  assert.match(html, /<video/);
  assert.match(html, /src="\/media"/);
  assert.match(html, /<h1>Película de prueba<\/h1>/);
  assert.match(html, /class="stream-data">👤 13 💾 866 MB ⚙️ YTS/);
});

test("carga automáticamente subtítulos de Stremio para el torrent activo", async (t) => {
  let subtitleProxyUrl;
  const app = await fixture({
    fetchImpl: async (url) => {
      const requestedUrl = String(url);
      if (requestedUrl.includes("/subtitles/movie/")) {
        return Response.json({
          subtitles: [
            {
              id: "subtitle-es-1",
              lang: "spa",
              url: "https://subs.example/movie-es-1.srt",
            },
            {
              id: "subtitle-es-2",
              lang: "spa",
              url: "https://subs.example/movie-es-2.srt",
            },
            {
              id: "subtitle-en",
              lang: "eng",
              url: "https://subs.example/movie-en.srt",
            },
          ],
        });
      }
      if (requestedUrl.includes("/subtitles.vtt?")) {
        subtitleProxyUrl = requestedUrl;
        return new Response(
          "WEBVTT\n\n00:01.000 --> 00:02.000\nHola\n",
          { headers: { "content-type": "text/vtt; charset=utf-8" } },
        );
      }
      return Response.json({
        streams: [
          {
            name: "Torrentio 1080p",
            infoHash: "abcdef0123456789abcdef0123456789abcdef01",
            fileIdx: 2,
          },
        ],
      });
    },
  });
  t.after(app.close);
  await app.configStore.save({
    torrentioManifestUrl: "https://torrentio.strem.fun/manifest.json",
  });

  await fetch(`${app.baseUrl}/stream/movie/tt1254207.json`);
  const activation = await fetch(
    `${app.baseUrl}/activate/candidate-1`,
  );
  const activationHtml = await activation.text();
  assert.match(activationHtml, /3 pistas automáticas disponibles/);
  assert.match(activationHtml, /name="subtitleLanguage"/);
  assert.match(activationHtml, /name="subtitleId"/);
  assert.match(activationHtml, /Fuente 1 · Español/);
  assert.match(activationHtml, /Fuente 2 · Español/);
  assert.match(activationHtml, /name="subtitleDelay"/);
  assert.match(activationHtml, /id="copyWatchUrl"/);

  const settings = await fetch(`${app.baseUrl}/settings`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "subtitleLanguage=es&subtitleId=subtitle-es-2&subtitleDelay=1.5",
  });
  assert.equal(settings.status, 200);

  const delayOnlySettings = await fetch(`${app.baseUrl}/settings`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "subtitleLanguage=es&subtitleId=subtitle-es-2&subtitleDelay=2.5",
  });
  assert.equal(delayOnlySettings.status, 200);

  const status = await fetch(`${app.baseUrl}/api/status`).then(
    (response) => response.json(),
  );
  assert.equal(status.version, 2);
  assert.equal(status.subtitleDelay, 2.5);
  assert.equal(status.subtitleId, "subtitle-es-2");
  assert.deepEqual((await app.configStore.load()).playbackSettings, {
    subtitleLanguage: "es",
    subtitleId: "subtitle-es-2",
    subtitleSourceIndex: 1,
    subtitleDelay: 2.5,
  });
  assert.match(
    status.serverInstanceId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

  const watch = await fetch(`${app.baseUrl}/watch`);
  const html = await watch.text();
  assert.doesNotMatch(html, /<track kind="subtitles"/);
  assert.match(
    html,
    /data-subtitle-url="\/subtitle\/1\.vtt\?version=2&amp;delay=0"/,
  );
  assert.doesNotMatch(html, /src="\/subtitle\/0\.vtt/);
  assert.match(html, /data-unilink-player/);
  assert.match(html, /data-player-part="seek-feedback"/);
  assert.match(
    html,
    new RegExp(
      `data-server-instance-id="${status.serverInstanceId}"`,
    ),
  );
  assert.match(html, /data-resume-key="movie:tt1254207"/);
  assert.match(html, /Subtítulos: Español · fuente 2/);
  assert.match(html, /src="\/player\.js"/);
  assert.doesNotMatch(html, /applySubtitleDelay/);

  const playerScript = await fetch(`${app.baseUrl}/player.js`);
  assert.match(playerScript.headers.get("content-type"), /text\/javascript/);
  assert.match(await playerScript.text(), /cueAtTime/);

  const subtitle = await fetch(`${app.baseUrl}/subtitle/1.vtt`);
  assert.equal(subtitle.status, 200);
  assert.equal(
    subtitleProxyUrl,
    "http://127.0.0.1:11470/subtitles.vtt?from=https%3A%2F%2Fsubs.example%2Fmovie-es-2.srt",
  );
  assert.match(
    await subtitle.text(),
    /00:00:03\.500 --> 00:00:04\.500/,
  );

  const restarted = await fixture({
    configStore: app.configStore,
    fetchImpl: async (url) => {
      const requestedUrl = String(url);
      if (requestedUrl.includes("/subtitles/movie/")) {
        return Response.json({
          subtitles: [
            {
              id: "subtitle-es-1",
              lang: "spa",
              url: "https://subs.example/movie-es-1.srt",
            },
            {
              id: "subtitle-es-2",
              lang: "spa",
              url: "https://subs.example/movie-es-2.srt",
            },
          ],
        });
      }
      return Response.json({
        streams: [
          {
            name: "Torrentio 720p",
            infoHash:
              "abcdef0123456789abcdef0123456789abcdef01",
          },
        ],
      });
    },
  });
  t.after(restarted.close);
  await fetch(`${restarted.baseUrl}/stream/movie/tt1254207.json`);
  const restartedActivation = await fetch(
    `${restarted.baseUrl}/activate/candidate-1`,
  );
  const restartedHtml = await restartedActivation.text();

  assert.match(restartedHtml, /value="2\.5"/);
  assert.match(
    restartedHtml,
    /value="subtitle-es-2"[\s\S]*?selected/,
  );
});

test("prepara, reordena y avanza una maratón de episodios", async (t) => {
  const streamRequests = [];
  const app = await fixture({
    fetchImpl: async (url) => {
      const requestedUrl = String(url);
      if (requestedUrl.includes("/meta/series/tt0944947.json")) {
        return Response.json({
          meta: {
            id: "tt0944947",
            name: "Serie de prueba",
            videos: [
              {
                id: "tt0944947:2:4",
                title: "Episodio cuatro",
                season: 2,
                episode: 4,
              },
              {
                id: "tt0944947:2:1",
                title: "Episodio actual",
                season: 2,
                episode: 1,
              },
              {
                id: "tt0944947:2:2",
                title: "Episodio dos",
                season: 2,
                episode: 2,
              },
              {
                id: "tt0944947:2:5",
                title: "Episodio cinco",
                season: 2,
                episode: 5,
              },
              {
                id: "tt0944947:2:3",
                title: "Episodio tres",
                season: 2,
                episode: 3,
              },
            ],
          },
        });
      }
      if (requestedUrl.includes("/subtitles/series/")) {
        return Response.json({ subtitles: [] });
      }
      if (requestedUrl.includes("/stream/series/")) {
        const videoId = decodeURIComponent(
          requestedUrl.match(/\/stream\/series\/(.+)\.json$/)[1],
        );
        streamRequests.push(videoId);
        return Response.json({
          streams: [
            {
              name: "Torrentio 1080p",
              description: "WEB-DL · H264 · AAC",
              url: `https://media.example/${videoId}.mp4`,
            },
            {
              name: "Torrentio 2160p",
              description: "WEB-DL · HEVC · HDR",
              url: `https://media.example/${videoId}-4k.mkv`,
            },
          ],
        });
      }
      if (requestedUrl.startsWith("https://media.example/")) {
        return new Response(requestedUrl, {
          headers: { "content-type": "video/mp4" },
        });
      }
      throw new Error(`Solicitud inesperada: ${requestedUrl}`);
    },
  });
  t.after(app.close);
  await app.configStore.save({
    torrentioManifestUrl: "https://torrentio.strem.fun/manifest.json",
    marathonSettings: {
      autoplay: true,
      countdownSeconds: 7,
      queueSize: 3,
    },
  });

  await fetch(
    `${app.baseUrl}/stream/series/${encodeURIComponent("tt0944947:2:1")}.json`,
  );
  const activation = await fetch(
    `${app.baseUrl}/activate/candidate-1`,
  );
  assert.equal(activation.status, 200);

  let status = await fetch(`${app.baseUrl}/api/status`).then(
    (response) => response.json(),
  );
  assert.equal(status.marathon.autoplay, true);
  assert.equal(status.marathon.countdownSeconds, 7);
  assert.deepEqual(
    status.marathon.items.map((item) => item.id),
    [
      "tt0944947:2:2",
      "tt0944947:2:3",
      "tt0944947:2:4",
    ],
  );
  assert.ok(status.marathon.items.every((item) => item.prepared));
  assert.deepEqual(streamRequests.sort(), [
    "tt0944947:2:1",
    "tt0944947:2:2",
    "tt0944947:2:3",
    "tt0944947:2:4",
  ]);

  const watch = await fetch(`${app.baseUrl}/watch`);
  const watchHtml = await watch.text();
  assert.match(watchHtml, /data-marathon/);
  assert.match(watchHtml, /data-marathon-list/);
  assert.match(watchHtml, /Episodio dos/);
  assert.match(watchHtml, /data-marathon-action="advance"/);
  assert.match(watchHtml, /data-marathon-action="toggle-autoplay"/);
  assert.match(watchHtml, /<h1>Episodio actual<\/h1>/);

  const move = await fetch(`${app.baseUrl}/api/marathon/move`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `id=${encodeURIComponent("tt0944947:2:4")}&direction=-1`,
  });
  assert.equal(move.status, 200);
  assert.deepEqual(
    (await move.json()).marathon.items.map((item) => item.id),
    [
      "tt0944947:2:2",
      "tt0944947:2:4",
      "tt0944947:2:3",
    ],
  );

  const remove = await fetch(`${app.baseUrl}/api/marathon/remove`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `id=${encodeURIComponent("tt0944947:2:2")}`,
  });
  assert.equal(remove.status, 200);
  assert.deepEqual(
    (await remove.json()).marathon.items.map((item) => item.id),
    [
      "tt0944947:2:4",
      "tt0944947:2:3",
      "tt0944947:2:5",
    ],
  );
  assert.ok(streamRequests.includes("tt0944947:2:5"));

  const settings = await fetch(
    `${app.baseUrl}/api/marathon/settings`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "autoplay=false&countdownSeconds=6&queueSize=3",
    },
  );
  assert.equal(settings.status, 200);
  assert.equal((await settings.json()).marathon.autoplay, false);
  assert.deepEqual(
    (await app.configStore.load()).marathonSettings,
    {
      autoplay: false,
      countdownSeconds: 6,
      queueSize: 3,
    },
  );

  const advance = await fetch(
    `${app.baseUrl}/api/marathon/advance`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `id=${encodeURIComponent("tt0944947:2:4")}`,
    },
  );
  assert.equal(advance.status, 200);
  status = await advance.json();
  assert.equal(status.active, true);
  assert.equal(status.contentId, "tt0944947:2:4");
  assert.equal(status.name, "Episodio cuatro");
  assert.deepEqual(
    status.marathon.items.map((item) => item.id),
    ["tt0944947:2:3", "tt0944947:2:5"],
  );

  const advancedWatch = await fetch(`${app.baseUrl}/watch`);
  assert.match(await advancedWatch.text(), /<h1>Episodio cuatro<\/h1>/);

  const media = await fetch(`${app.baseUrl}/media`);
  assert.match(await media.text(), /tt0944947:2:4\.mp4/);

  const staleAdvance = await fetch(
    `${app.baseUrl}/api/marathon/advance`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `id=${encodeURIComponent("tt0944947:2:4")}`,
    },
  );
  assert.equal(staleAdvance.status, 409);
  assert.match((await staleAdvance.json()).error, /cola ha cambiado/i);
});

test("degrada la maratón sin interrumpir el episodio activo", async (t) => {
  const app = await fixture({
    fetchImpl: async (url) => {
      const requestedUrl = String(url);
      if (requestedUrl.includes("/subtitles/series/")) {
        return Response.json({ subtitles: [] });
      }
      if (requestedUrl.includes("/meta/series/")) {
        return new Response("metadata unavailable", { status: 503 });
      }
      throw new Error(`Solicitud inesperada: ${requestedUrl}`);
    },
  });
  t.after(app.close);
  const id = app.registry.addCandidate({
    url: "https://media.example/current.mp4",
    unilinkContent: {
      type: "series",
      id: "tt0944947:2:1",
    },
  });
  await app.configStore.save({
    torrentioManifestUrl: "https://torrentio.strem.fun/manifest.json",
  });

  const activation = await fetch(`${app.baseUrl}/activate/${id}`);
  assert.equal(activation.status, 200);

  const status = await fetch(`${app.baseUrl}/api/status`).then(
    (response) => response.json(),
  );
  assert.equal(status.active, true);
  assert.deepEqual(status.marathon.items, []);
  assert.match(status.marathon.warning, /Metadatos HTTP 503/);

  const advance = await fetch(
    `${app.baseUrl}/api/marathon/advance`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "id=tt0944947%3A2%3A2",
    },
  );
  assert.equal(advance.status, 409);
  assert.match((await advance.json()).error, /fuente preparada/);
});

test("el proxy conserva Range y las cabeceras de respuesta", async (t) => {
  let upstreamRange;
  const app = await fixture({
    fetchImpl: async (_url, init) => {
      upstreamRange = new Headers(init.headers).get("range");
      return new Response("56789", {
        status: 206,
        headers: {
          "accept-ranges": "bytes",
          "content-length": "5",
          "content-range": "bytes 5-9/10",
          "content-type": "video/mp4",
        },
      });
    },
  });
  t.after(app.close);
  const id = app.registry.addCandidate({
    url: "https://example.com/movie.mp4",
    behaviorHints: {
      proxyHeaders: {
        response: { "content-type": "video/webm" },
      },
    },
  });
  app.registry.activate(id);

  const response = await fetch(`${app.baseUrl}/media`, {
    headers: { range: "bytes=5-9" },
  });

  assert.equal(upstreamRange, "bytes=5-9");
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 5-9/10");
  assert.equal(response.headers.get("content-type"), "video/webm");
  assert.equal(await response.text(), "56789");
});

test("la URL fija informa cuando no existe una reproducción activa", async (t) => {
  const app = await fixture();
  t.after(app.close);

  const response = await fetch(`${app.baseUrl}/watch`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Esperando una película/);
});
