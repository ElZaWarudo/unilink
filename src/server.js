import { Readable } from "node:stream";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import {
  normalizeTorrentioManifestUrl,
  torrentioResourceUrl,
} from "./config.js";
import {
  buildStremioSourceUrl,
  decorateTorrentioStreams,
} from "./streams.js";
import {
  DEFAULT_SUBTITLES_MANIFEST_URL,
  normalizeSubtitleTracks,
  shiftWebVtt,
  subtitleConversionUrl,
  subtitlesResourceUrl,
} from "./subtitles.js";
import {
  DEFAULT_METADATA_MANIFEST_URL,
  metadataResourceUrl,
  parseSeriesVideoId,
  rankMarathonStreams,
  seriesQueueVideos,
} from "./marathon.js";
import { isLocalNetworkAddress } from "./network.js";
import {
  activationPage,
  configurationPage,
  errorPage,
  watchPage,
} from "./pages.js";

const MANIFEST = {
  id: "community.unilink.local",
  version: "0.1.0",
  name: "Unilink · Servir en red",
  description:
    "Expone en la red local una fuente elegida desde Torrentio para verla en un navegador.",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
  configurable: true,
  behaviorHints: {
    configurable: true,
    configurationRequired: false,
  },
};
const PLAYER_SCRIPT = readFile(new URL("./player.js", import.meta.url));
const SUBTITLE_DELAY_SCRIPT = readFile(
  new URL("./subtitle-delay.js", import.meta.url),
);
const SUBTITLE_SYNC_SCRIPT = readFile(
  new URL("./subtitle-sync.js", import.meta.url),
);

const FORWARDED_RESPONSE_HEADERS = [
  "accept-ranges",
  "cache-control",
  "content-disposition",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
];
const BLOCKED_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "transfer-encoding",
]);
const CONFIGURABLE_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-disposition",
  "content-type",
]);
const MARATHON_SOURCE_LIMIT = 3;

function applyCommonHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  response.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges, X-Unilink-Warning",
  );
}

function isTrustedMutationRequest(request) {
  const fetchSite = String(request.headers["sec-fetch-site"] ?? "")
    .trim()
    .toLowerCase();
  if (fetchSite === "cross-site") {
    return false;
  }
  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "http:" && parsed.host === request.headers.host
    );
  } catch {
    return false;
  }
}

function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(body);
}

function sendHtml(response, status, html) {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}

function isLoopback(address = "") {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

async function readForm(request, limit = 32_768) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > limit) {
      throw new Error("El formulario es demasiado grande.");
    }
  }
  return new URLSearchParams(body);
}

function requestHeadersForSource(request, source) {
  const headers = new Headers();
  for (const name of ["range", "if-range", "if-none-match", "user-agent"]) {
    const value = request.headers[name];
    if (value) {
      headers.set(name, value);
    }
  }
  const configured = source.behaviorHints?.proxyHeaders?.request ?? {};
  for (const [name, value] of Object.entries(configured)) {
    if (!BLOCKED_REQUEST_HEADERS.has(name.toLowerCase())) {
      headers.set(name, String(value));
    }
  }
  return headers;
}

async function proxyActiveStream({
  request,
  response,
  registry,
  fetchImpl,
  stremioServerUrl,
}) {
  if (!registry.active) {
    sendHtml(response, 404, errorPage(404, "No hay ninguna fuente activa."));
    return;
  }

  let upstreamUrl;
  try {
    upstreamUrl = buildStremioSourceUrl(
      registry.active,
      stremioServerUrl,
    );
  } catch (error) {
    sendHtml(response, 422, errorPage(422, error.message));
    return;
  }

  let upstream;
  const controller = new AbortController();
  const connectionTimeout = setTimeout(() => controller.abort(), 30_000);
  const closeHandler = () => controller.abort();
  response.once("close", closeHandler);
  try {
    upstream = await fetchImpl(upstreamUrl, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers: requestHeadersForSource(request, registry.active),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(connectionTimeout);
    response.off("close", closeHandler);
    sendHtml(
      response,
      502,
      errorPage(
        502,
        `No se pudo conectar con el servidor de streaming de Stremio: ${error.message}`,
      ),
    );
    return;
  }
  clearTimeout(connectionTimeout);

  const headers = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) {
      headers[name] = value;
    }
  }
  const configuredResponseHeaders =
    registry.active.behaviorHints?.proxyHeaders?.response ?? {};
  for (const [name, value] of Object.entries(configuredResponseHeaders)) {
    const normalizedName = name.toLowerCase();
    if (CONFIGURABLE_RESPONSE_HEADERS.has(normalizedName)) {
      headers[normalizedName] = String(value);
    }
  }
  response.writeHead(upstream.status, headers);
  if (request.method === "HEAD" || !upstream.body) {
    response.off("close", closeHandler);
    response.end();
    return;
  }

  const body = Readable.fromWeb(upstream.body);
  response.off("close", closeHandler);
  body.on("error", () => response.destroy());
  response.on("close", () => {
    controller.abort();
    body.destroy();
  });
  body.pipe(response);
}

async function proxySubtitle({
  index,
  delay,
  response,
  registry,
  fetchImpl,
  stremioServerUrl,
}) {
  const subtitle = registry.active?.subtitles?.[index];
  if (!subtitle) {
    sendHtml(response, 404, errorPage(404, "Subtítulo no disponible."));
    return;
  }

  const upstream = await fetchImpl(
    subtitleConversionUrl(subtitle.url, stremioServerUrl),
    { signal: AbortSignal.timeout(20_000) },
  );
  if (!upstream.ok) {
    sendHtml(
      response,
      502,
      errorPage(
        502,
        `Stremio no pudo preparar el subtítulo (${upstream.status}).`,
      ),
    );
    return;
  }

  const content = shiftWebVtt(
    await upstream.text(),
    delay ?? registry.active.playbackSettings?.subtitleDelay,
  );
  response.writeHead(200, {
    "content-type": "text/vtt; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(content);
}

async function loadActiveSubtitles({
  registry,
  fetchImpl,
  stremioServerUrl,
  subtitlesManifestUrl,
}) {
  const active = registry.active;
  let warning = "";
  try {
    const content = active?.unilinkContent;
    let subtitles = active?.subtitles ?? [];
    if (content) {
      const subtitleResponse = await fetchImpl(
        subtitlesResourceUrl(
          subtitlesManifestUrl,
          content.type,
          content.id,
        ),
        {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!subtitleResponse.ok) {
        throw new Error(`HTTP ${subtitleResponse.status}`);
      }
      const payload = await subtitleResponse.json();
      subtitles = [...subtitles, ...(payload.subtitles ?? [])];
    }
    registry.setSubtitles(normalizeSubtitleTracks(subtitles));
  } catch (error) {
    registry.setSubtitles(normalizeSubtitleTracks(active?.subtitles));
    warning = `No se pudieron cargar subtítulos automáticos: ${error.message}`;
  }
  return warning;
}

async function prepareMarathonItem({
  video,
  currentSource,
  torrentioManifestUrl,
  registry,
  fetchImpl,
}) {
  try {
    const response = await fetchImpl(
      torrentioResourceUrl(
        torrentioManifestUrl,
        "series",
        video.id,
      ),
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Torrentio respondió con HTTP ${response.status}.`);
    }
    const payload = await response.json();
    const ranked = rankMarathonStreams(
      currentSource,
      payload.streams ?? [],
    );
    const candidateIds = [];
    for (const source of ranked) {
      try {
        candidateIds.push(
          registry.addCandidate({
            ...source,
            unilinkContent: {
              type: "series",
              id: video.id,
            },
            unilinkEpisode: video,
          }),
        );
      } catch {
        // Ignore stream shapes that Unilink cannot proxy.
      }
      if (candidateIds.length === MARATHON_SOURCE_LIMIT) {
        break;
      }
    }
    return {
      ...video,
      candidateIds,
      error:
        candidateIds.length > 0
          ? ""
          : "Torrentio no devolvió una fuente compatible.",
    };
  } catch (error) {
    return {
      ...video,
      candidateIds: [],
      error: error.message,
    };
  }
}

async function prepareMarathonItems({
  videos,
  currentSource,
  torrentioManifestUrl,
  registry,
  fetchImpl,
}) {
  return Promise.all(
    videos.map((video) =>
      prepareMarathonItem({
        video,
        currentSource,
        torrentioManifestUrl,
        registry,
        fetchImpl,
      }),
    ),
  );
}

async function prepareSeriesMarathon({
  registry,
  config,
  fetchImpl,
  metadataManifestUrl,
}) {
  registry.clearMarathon();
  const content = registry.active?.unilinkContent;
  const parsed = parseSeriesVideoId(content?.id);
  if (content?.type !== "series" || !parsed) {
    return;
  }
  registry.setMarathon();
  if (!config.torrentioManifestUrl) {
    registry.setMarathonWarning(
      "Configura Torrentio para preparar los siguientes episodios.",
    );
    return;
  }
  try {
    const response = await fetchImpl(
      metadataResourceUrl(metadataManifestUrl, parsed.imdbId),
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Metadatos HTTP ${response.status}.`);
    }
    const payload = await response.json();
    const currentVideo = (payload.meta?.videos ?? []).find(
      (video) =>
        parseSeriesVideoId(video?.id)?.videoId ===
        parsed.videoId,
    );
    if (currentVideo) {
      registry.setActiveEpisodeMetadata({
        id: parsed.videoId,
        title:
          String(currentVideo.title ?? "").trim() ||
          `Temporada ${parsed.season} · Episodio ${parsed.episode}`,
        season: parsed.season,
        episode: parsed.episode,
        thumbnail: String(currentVideo.thumbnail ?? "").trim(),
        released: String(currentVideo.released ?? "").trim(),
      });
    }
    const following = seriesQueueVideos(
      payload.meta?.videos,
      content.id,
      { limit: 500 },
    );
    const queueSize = registry.marathonSettings.queueSize;
    const initial = following.slice(0, queueSize);
    const pending = following.slice(queueSize);
    const items = await prepareMarathonItems({
      videos: initial,
      currentSource: registry.active,
      torrentioManifestUrl: config.torrentioManifestUrl,
      registry,
      fetchImpl,
    });
    registry.setMarathon({ items, pending });
  } catch (error) {
    registry.setMarathon({
      warning: `No se pudo preparar la maratón: ${error.message}`,
    });
  }
}

async function fillMarathonQueue({
  registry,
  config,
  fetchImpl,
}) {
  const status = registry.marathonStatus();
  if (!status || !config.torrentioManifestUrl) {
    return status;
  }
  const missing = Math.max(
    0,
    registry.marathonSettings.queueSize - status.items.length,
  );
  const videos = registry.takePendingMarathonVideos(missing);
  if (videos.length === 0) {
    return status;
  }
  const items = await prepareMarathonItems({
    videos,
    currentSource: registry.active,
    torrentioManifestUrl: config.torrentioManifestUrl,
    registry,
    fetchImpl,
  });
  return registry.appendMarathonItems(items);
}

function playerStatus(registry, serverInstanceId, watchUrl) {
  return {
    active: Boolean(registry.active),
    version: registry.active?.version ?? 0,
    serverInstanceId,
    watchUrl,
    contentId: registry.active?.unilinkContent?.id ?? null,
    subtitleDelay:
      registry.active?.playbackSettings?.subtitleDelay ?? 0,
    subtitleId:
      registry.active?.playbackSettings?.subtitleId ?? "",
    name:
      registry.active?.unilinkEpisode?.title ??
      registry.active?.description ??
      registry.active?.title ??
      registry.active?.name ??
      null,
    marathon: registry.marathonStatus(),
  };
}

export function createUnilinkServer({
  configStore,
  registry,
  activationBaseUrl,
  watchUrl = `${activationBaseUrl}/watch`,
  manifestUrl = `${activationBaseUrl}/manifest.json`,
  stremioServerUrl = "http://127.0.0.1:11470",
  subtitlesManifestUrl = DEFAULT_SUBTITLES_MANIFEST_URL,
  metadataManifestUrl = DEFAULT_METADATA_MANIFEST_URL,
  fetchImpl = fetch,
}) {
  const serverInstanceId = randomUUID();
  let subtitleDelayUpdates = Promise.resolve();

  return createServer(async (request, response) => {
    applyCommonHeaders(response);
    if (!isLocalNetworkAddress(request.socket.remoteAddress)) {
      sendHtml(
        response,
        403,
        errorPage(403, "Unilink solo acepta conexiones de la red local."),
      );
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url, "http://unilink.local");
    try {
      if (url.pathname === "/manifest.json" && request.method === "GET") {
        sendJson(response, 200, MANIFEST);
        return;
      }

      if (url.pathname === "/player.js" && request.method === "GET") {
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(await PLAYER_SCRIPT);
        return;
      }

      if (
        url.pathname === "/subtitle-delay.js" &&
        request.method === "GET"
      ) {
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(await SUBTITLE_DELAY_SCRIPT);
        return;
      }

      if (
        url.pathname === "/subtitle-sync.js" &&
        request.method === "GET"
      ) {
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(await SUBTITLE_SYNC_SCRIPT);
        return;
      }

      if (url.pathname === "/configure" && request.method === "GET") {
        if (!isLoopback(request.socket.remoteAddress)) {
          sendHtml(
            response,
            403,
            errorPage(403, "La configuración solo está disponible en el PC."),
          );
          return;
        }
        const config = await configStore.load();
        sendHtml(
          response,
          200,
          configurationPage({
            currentUrl: config.torrentioManifestUrl,
            saved: url.searchParams.get("saved") === "1",
            manifestUrl,
          }),
        );
        return;
      }

      if (url.pathname === "/configure" && request.method === "POST") {
        if (!isLoopback(request.socket.remoteAddress)) {
          sendHtml(
            response,
            403,
            errorPage(403, "La configuración solo está disponible en el PC."),
          );
          return;
        }
        const form = await readForm(request);
        const rawUrl = form.get("torrentioManifestUrl");
        let normalized;
        try {
          normalized = normalizeTorrentioManifestUrl(rawUrl);
          await configStore.save({ torrentioManifestUrl: normalized });
        } catch (error) {
          sendHtml(
            response,
            400,
            configurationPage({
              currentUrl: rawUrl,
              error: error.message,
              manifestUrl,
            }),
          );
          return;
        }
        response.writeHead(303, { location: "/configure?saved=1" });
        response.end();
        return;
      }

      const streamMatch = url.pathname.match(
        /^\/stream\/(movie|series)\/(.+)\.json$/,
      );
      if (streamMatch && request.method === "GET") {
        const [, type, encodedId] = streamMatch;
        const id = decodeURIComponent(encodedId);
        const config = await configStore.load();
        if (!config.torrentioManifestUrl) {
          sendJson(
            response,
            200,
            { streams: [] },
            { "x-unilink-warning": "Configura Torrentio en /configure" },
          );
          return;
        }

        const upstreamUrl = torrentioResourceUrl(
          config.torrentioManifestUrl,
          type,
          id,
        );
        try {
          const upstream = await fetchImpl(upstreamUrl, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(20_000),
          });
          if (!upstream.ok) {
            throw new Error(
              `Torrentio respondió con HTTP ${upstream.status}.`,
            );
          }
          const payload = await upstream.json();
          const streams = decorateTorrentioStreams(payload.streams ?? [], {
            activationBaseUrl,
            registry,
            content: { type, id },
          });
          sendJson(response, 200, { streams });
        } catch (error) {
          sendJson(
            response,
            200,
            { streams: [] },
            { "x-unilink-warning": error.message },
          );
        }
        return;
      }

      const activationMatch = url.pathname.match(/^\/activate\/([^/]+)$/);
      if (activationMatch && request.method === "GET") {
        if (!isLoopback(request.socket.remoteAddress)) {
          sendHtml(
            response,
            403,
            errorPage(403, "La activación debe iniciarse desde Stremio en el PC."),
          );
          return;
        }
        const config = await configStore.load();
        registry.setPlaybackDefaults(config.playbackSettings);
        registry.setMarathonSettings(config.marathonSettings);
        registry.clearMarathon();
        const active = registry.activate(
          decodeURIComponent(activationMatch[1]),
        );
        const [subtitleWarning] = await Promise.all([
          loadActiveSubtitles({
            registry,
            fetchImpl,
            stremioServerUrl,
            subtitlesManifestUrl,
          }),
          prepareSeriesMarathon({
            registry,
            config,
            fetchImpl,
            metadataManifestUrl,
          }),
        ]);
        sendHtml(
          response,
          200,
          activationPage({ watchUrl, active, subtitleWarning }),
        );
        return;
      }

      if (url.pathname === "/settings" && request.method === "POST") {
        if (!isLoopback(request.socket.remoteAddress)) {
          sendHtml(
            response,
            403,
            errorPage(403, "Los ajustes solo están disponibles en el PC."),
          );
          return;
        }
        const form = await readForm(request);
        const active = registry.setPlaybackSettings({
          subtitleLanguage: form.get("subtitleLanguage"),
          subtitleId: form.get("subtitleId"),
          subtitleDelay: form.get("subtitleDelay"),
        });
        await configStore.save({
          playbackSettings: active.playbackSettings,
        });
        sendHtml(
          response,
          200,
          activationPage({ watchUrl, active, settingsSaved: true }),
        );
        return;
      }

      if (url.pathname === "/watch" && request.method === "GET") {
        sendHtml(
          response,
          200,
          watchPage({
            active: registry.active,
            serverInstanceId,
            marathon: registry.marathonStatus(),
          }),
        );
        return;
      }

      if (url.pathname === "/api/status" && request.method === "GET") {
        sendJson(
          response,
          200,
          playerStatus(registry, serverInstanceId, watchUrl),
        );
        return;
      }

      if (
        url.pathname === "/api/subtitles/delay" &&
        request.method === "POST"
      ) {
        response.removeHeader("Access-Control-Allow-Origin");
        if (!isTrustedMutationRequest(request)) {
          sendJson(response, 403, {
            error: "Origen no permitido.",
          });
          return;
        }
        const form = await readForm(request);
        const update = subtitleDelayUpdates.then(async () => {
          if (!registry.active) {
            return {
              status: 409,
              body: { error: "No hay ninguna reproducción activa." },
            };
          }
          const expectedVersion = Number(form.get("expectedVersion"));
          const expectedInstance = form.get("expectedServerInstanceId");
          if (
            expectedVersion !== registry.active.version ||
            expectedInstance !== serverInstanceId
          ) {
            return {
              status: 409,
              body: {
                ...playerStatus(registry, serverInstanceId, watchUrl),
                error: "La reproducción ha cambiado. Recargando…",
                stale: true,
              },
            };
          }

          const previousDelay =
            registry.active.playbackSettings?.subtitleDelay ?? 0;
          const active = registry.setSubtitleDelay(
            form.get("subtitleDelay"),
          );
          if (active.playbackSettings.subtitleDelay !== previousDelay) {
            try {
              await configStore.save({
                playbackSettings: active.playbackSettings,
              });
            } catch (error) {
              registry.setSubtitleDelay(previousDelay);
              throw error;
            }
          }
          return {
            status: 200,
            body: playerStatus(registry, serverInstanceId, watchUrl),
          };
        });
        subtitleDelayUpdates = update.then(
          () => undefined,
          () => undefined,
        );
        const result = await update;
        sendJson(response, result.status, result.body);
        return;
      }

      if (
        url.pathname === "/api/marathon/settings" &&
        request.method === "POST"
      ) {
        const form = await readForm(request);
        const settings = registry.setMarathonSettings({
          autoplay: form.get("autoplay"),
          countdownSeconds: form.get("countdownSeconds"),
          queueSize: form.get("queueSize"),
        });
        const config = await configStore.save({
          marathonSettings: settings,
        });
        await fillMarathonQueue({ registry, config, fetchImpl });
        sendJson(
          response,
          200,
          playerStatus(registry, serverInstanceId, watchUrl),
        );
        return;
      }

      if (
        url.pathname === "/api/marathon/move" &&
        request.method === "POST"
      ) {
        const form = await readForm(request);
        registry.moveMarathonItem(
          form.get("id"),
          form.get("direction"),
        );
        sendJson(
          response,
          200,
          playerStatus(registry, serverInstanceId, watchUrl),
        );
        return;
      }

      if (
        url.pathname === "/api/marathon/remove" &&
        request.method === "POST"
      ) {
        const form = await readForm(request);
        registry.removeMarathonItem(form.get("id"));
        const config = await configStore.load();
        await fillMarathonQueue({ registry, config, fetchImpl });
        sendJson(
          response,
          200,
          playerStatus(registry, serverInstanceId, watchUrl),
        );
        return;
      }

      if (
        url.pathname === "/api/marathon/advance" &&
        request.method === "POST"
      ) {
        const form = await readForm(request);
        const config = await configStore.load();
        try {
          registry.advanceMarathon(form.get("id"));
        } catch (error) {
          sendJson(response, 409, {
            error: error.message,
            ...playerStatus(registry, serverInstanceId, watchUrl),
          });
          return;
        }
        await Promise.all([
          loadActiveSubtitles({
            registry,
            fetchImpl,
            stremioServerUrl,
            subtitlesManifestUrl,
          }),
          fillMarathonQueue({ registry, config, fetchImpl }),
        ]);
        sendJson(
          response,
          200,
          playerStatus(registry, serverInstanceId, watchUrl),
        );
        return;
      }

      const subtitleMatch = url.pathname.match(/^\/subtitle\/(\d+)\.vtt$/);
      if (subtitleMatch && request.method === "GET") {
        const requestedDelay = Number(url.searchParams.get("delay"));
        await proxySubtitle({
          index: Number(subtitleMatch[1]),
          delay:
            url.searchParams.has("delay") && Number.isFinite(requestedDelay)
              ? Math.max(-30, Math.min(30, requestedDelay))
              : undefined,
          response,
          registry,
          fetchImpl,
          stremioServerUrl,
        });
        return;
      }

      if (
        url.pathname === "/media" &&
        ["GET", "HEAD"].includes(request.method)
      ) {
        await proxyActiveStream({
          request,
          response,
          registry,
          fetchImpl,
          stremioServerUrl,
        });
        return;
      }

      sendHtml(response, 404, errorPage(404, "Ruta no encontrada."));
    } catch (error) {
      if (!response.headersSent) {
        sendHtml(response, 500, errorPage(500, error.message));
      } else {
        response.destroy(error);
      }
    }
  });
}
