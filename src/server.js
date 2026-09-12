import { Readable } from "node:stream";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { HLS_RESOURCE, proxyHls } from "./hls.js";
import { StremioSync } from "./stremio-sync.js";
import { handleStremioRequest, sameOriginRequest } from "./stremio-routes.js";
import { SubtitleSync } from "./subtitle-sync.js";
import { SpeechSetup } from "./speech-setup.js";

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
  subtitleSelection,
  watchPage,
} from "./pages.js";

const MANIFEST = {
  id: "community.unilink.local",
  version: "0.2.0",
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
const HLS_SCRIPT = readFile(new URL("../node_modules/hls.js/dist/hls.min.js", import.meta.url));

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
    if (registry.active === active) registry.setSubtitles(normalizeSubtitleTracks(subtitles));
  } catch (error) {
    if (registry.active === active) registry.setSubtitles(normalizeSubtitleTracks(active?.subtitles));
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
    if (registry.active !== currentSource) return null;
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
  const active = registry.active;
  registry.clearMarathon();
  const content = active?.unilinkContent;
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
    if (registry.active !== active) return;
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
      currentSource: active,
      torrentioManifestUrl: config.torrentioManifestUrl,
      registry,
      fetchImpl,
    });
    if (registry.active === active) registry.setMarathon({ items: items.filter(Boolean), pending });
  } catch (error) {
    if (registry.active !== active) return;
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
  const active = registry.active;
  const marathon = registry.marathon;
  if (!marathon || !config.torrentioManifestUrl) return registry.marathonStatus();
  if (marathon.filling) {
    await marathon.filling;
    if (registry.active !== active || registry.marathon !== marathon) return registry.marathonStatus();
    return fillMarathonQueue({ registry, config, fetchImpl });
  }
  const missing = Math.max(0, registry.marathonSettings.queueSize - marathon.items.length);
  const videos = registry.takePendingMarathonVideos(missing);
  if (!videos.length) return registry.marathonStatus();
  marathon.filling = prepareMarathonItems({ videos, currentSource: active,
    torrentioManifestUrl: config.torrentioManifestUrl, registry, fetchImpl });
  try {
    const items = await marathon.filling;
    if (registry.active === active && registry.marathon === marathon) registry.appendMarathonItems(items.filter(Boolean));
    else if (registry.marathon === marathon) marathon.pending.unshift(...videos);
    return registry.marathonStatus();
  } finally { marathon.filling = null; }
}

function playerStatus(registry, serverInstanceId, watchUrl) {
  const selectedSubtitle = subtitleSelection(registry.active);
  return {
    active: Boolean(registry.active),
    preparing: Boolean(registry.active?.preparing),
    version: registry.active?.version ?? 0,
    serverInstanceId,
    watchUrl,
    contentId: registry.active?.unilinkContent?.id ?? null,
    subtitleDelay:
      registry.active?.playbackSettings?.subtitleDelay ?? 0,
    subtitleId:
      registry.active?.playbackSettings?.subtitleId ?? "",
    subtitleUrl: selectedSubtitle.url,
    subtitleLanguage: selectedSubtitle.subtitle?.language ?? "",
    subtitleStatus: selectedSubtitle.status,
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
  subtitleSync = new SubtitleSync(),
  speechSetup = new SpeechSetup(),
}) {
  const serverInstanceId = randomUUID();
  const adminToken = randomUUID();
  const progressToken = randomUUID();
  const stremioSync = new StremioSync({ configStore, fetchImpl });

  const server = createServer(async (request, response) => {
    applyCommonHeaders(response);
    const url = new URL(request.url, "http://unilink.local");
    const pathname = url.pathname;
    if (["/watch", "/session", "/settings", "/configure", "/api/progress", "/api/subtitle-sync", "/api/speech-setup"].includes(pathname) || pathname.startsWith("/api/stremio/") || pathname.startsWith("/api/marathon/")) {
      response.removeHeader("Access-Control-Allow-Origin");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Frame-Options", "DENY");
      if (!sameOriginRequest(request, ["/watch", "/session", "/configure"].includes(pathname))) {
        sendJson(response, 403, { error: "Acceso no permitido." });
        return;
      }
    }
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

    try {
      let sessionForm;
      let sessionActive;
      const currentSession = () => Boolean(sessionActive && registry.active === sessionActive);
      const rejectStale = () => {
        sendJson(response, 409, { error: "La fuente ha cambiado. Recarga la página.", state: "stale" });
      };
      if (request.method === "POST" && (pathname === "/settings" || pathname.startsWith("/api/marathon/"))) {
        sessionForm = await readForm(request);
        sessionActive = registry.active;
        if (!sessionActive || sessionForm.get("serverInstanceId") !== serverInstanceId ||
            sessionForm.get("version") !== String(sessionActive.version)) { rejectStale(); return; }
      }
      if (await handleStremioRequest({ request, response, pathname: url.pathname,
        sync: stremioSync, registry, serverInstanceId, adminToken, progressToken,
        loopback: isLoopback(request.socket.remoteAddress) })) return;
      if (sessionForm && !currentSession()) { rejectStale(); return; }
      if (pathname === "/api/speech-setup") {
        if (!isLoopback(request.socket.remoteAddress) || request.headers["x-unilink-token"] !== adminToken) {
          sendJson(response, 403, { error: "La instalación solo está disponible desde la configuración del PC." });
          return;
        }
        if (request.method === "GET") {
          sendJson(response, 200, await speechSetup.status());
        } else if (request.method === "POST") {
          await subtitleSync.release?.();
          sendJson(response, 202, speechSetup.start());
        } else {
          sendJson(response, 405, { error: "Método no permitido." });
        }
        return;
      }
      if (pathname === "/api/subtitle-sync") {
        if (request.headers["x-unilink-token"] !== progressToken) {
          sendJson(response, 403, { state: "error" });
          return;
        }
        const jobId = url.searchParams.get("job");
        if (request.method === "GET") {
          sendJson(response, 200, jobId ? subtitleSync.get(jobId) : { available: !speechSetup.task && await subtitleSync.available() });
          return;
        }
        if (request.method === "DELETE" && jobId) {
          sendJson(response, 200, subtitleSync.cancel(jobId));
          return;
        }
        if (request.method !== "POST") { sendJson(response, 405, { state: "error" }); return; }
        let raw = "";
        for await (const chunk of request) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 2048) { sendJson(response, 413, { state: "error" }); return; }
        }
        let body;
        try { body = JSON.parse(raw); } catch { sendJson(response, 400, { state: "error" }); return; }
        if (!body || !Number.isFinite(body.time) || !Number.isFinite(body.duration) || body.duration < 30 ||
            body.duration > 28800 || body.time < 0 || body.time >= body.duration ||
              !Number.isInteger(body.audioIndex) || body.audioIndex < 0 || body.audioIndex > 15 ||
              (body.requestId !== undefined && (typeof body.requestId !== "string" || body.requestId.length > 100))) {
          sendJson(response, 400, { state: "error" }); return;
        }
        const active = registry.active;
        const selected = subtitleSelection(active);
        const selectionIdentity = JSON.stringify([selected.subtitle?.id, selected.subtitle?.url, selected.subtitle?.language]);
          const isCurrent = () => {
            const currentSelection = subtitleSelection(registry.active);
            return Boolean(active && registry.active === active && body.version === active.version &&
              body.serverInstanceId === serverInstanceId && body.subtitleUrl === currentSelection.url &&
              selectionIdentity === JSON.stringify([currentSelection.subtitle?.id,
                currentSelection.subtitle?.url, currentSelection.subtitle?.language]));
          };
        if (!isCurrent()) { sendJson(response, 409, { state: "stale" }); return; }
        if (selected.subtitle?.language !== "en") { sendJson(response, 422, { state: "insufficient", reason: "english_only" }); return; }
        if (!await subtitleSync.available() || speechSetup.task) { sendJson(response, 503, { state: "unavailable" }); return; }
        const start = Math.max(0, Math.min(Math.floor(body.time / 60) * 60 - 20, body.duration - 30));
        const window = { start, duration: Math.min(120, body.duration - start) };
        const local = `http://127.0.0.1:${server.address().port}`;
        const mediaUrl = `${local}/media?instance=${serverInstanceId}&version=${active.version}`;
        const result = subtitleSync.start({
          key: JSON.stringify([serverInstanceId, active.version, selectionIdentity, body.audioIndex, start]),
            isCurrent, window, requestId: body.requestId,
          prepare: async signal => {
            const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
            const master = await fetch(`${local}/hls/${serverInstanceId}/${active.version}/master.m3u8`, { signal: requestSignal });
            if (!master.ok) throw new Error("audio unavailable");
            const playlist = await master.text();
            const audioLines = playlist.split(/\r?\n/).filter(line => /^#EXT-X-MEDIA:TYPE=AUDIO,/.test(line));
            const audioMatch = audioLines[body.audioIndex]?.match(/URI="[^"]*\/audio(\d+)\.m3u8"/);
            if (!audioMatch) throw new Error("audio track unavailable");
            const subtitle = await fetchImpl(subtitleConversionUrl(selected.subtitle.url, stremioServerUrl), { signal: requestSignal });
            if (!subtitle.ok) throw new Error("subtitles unavailable");
            let subtitles = "";
            const decoder = new TextDecoder();
            let size = 0;
            for await (const chunk of subtitle.body) {
              size += chunk.byteLength;
              if (size > 2000000) throw new Error("subtitles too large");
              subtitles += decoder.decode(chunk, { stream: true });
            }
            subtitles += decoder.decode();
            return { mediaUrl, audioIndex: Number(audioMatch[1]), subtitles };
          },
        });
        sendJson(response, result.state === "working" ? 202 : 200, result);
        return;
      }
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

      if (url.pathname === "/hls.js" && request.method === "GET") {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        response.end(await HLS_SCRIPT);
        return;
      }

      const hlsMatch = url.pathname.match(/^\/hls\/([a-f0-9-]+)\/(\d+)\/(.+)$/);
      if (hlsMatch && ["GET", "HEAD"].includes(request.method)) {
        const [, instanceId, version, resource] = hlsMatch;
        if (!HLS_RESOURCE.test(resource) && resource !== "audio.json") {
          sendJson(response, 404, { error: "Recurso HLS no disponible." });
          return;
        }
        if (instanceId !== serverInstanceId || Number(version) !== registry.active?.version) {
          sendJson(response, 409, { error: "La fuente ha cambiado. Recarga el reproductor." });
          return;
        }
        const mediaUrl = `http://127.0.0.1:${server.address().port}/media?instance=${serverInstanceId}&version=${version}`;
        const audioIndex = url.searchParams.has("audio") ? Number(url.searchParams.get("audio")) : undefined;
        if (audioIndex !== undefined && (!Number.isInteger(audioIndex) || audioIndex < 0)) {
          sendJson(response, 400, { error: "Pista de audio no válida." });
          return;
        }
        await proxyHls({ request, response, resource, audioIndex, instanceId, version, stremioServerUrl, mediaUrl, fetchImpl });
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
            stremioToken: adminToken,
            saved: url.searchParams.get("saved") === "1",
            manifestUrl,
            watchUrl,
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
          if (request.headers.accept?.includes("application/json")) {
            sendJson(response, 400, { error: error.message });
            return;
          }
          sendHtml(
            response,
            400,
            configurationPage({
              currentUrl: rawUrl,
              stremioToken: adminToken,
              error: error.message,
              manifestUrl,
            watchUrl,
            }),
          );
          return;
        }
        if (request.headers.accept?.includes("application/json")) {
          sendJson(response, 200, { saved: true });
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
        const active = registry.activate(
          decodeURIComponent(activationMatch[1]),
        );
        active.preparing = true;
        void Promise.all([
          loadActiveSubtitles({ registry, fetchImpl, stremioServerUrl, subtitlesManifestUrl }),
          prepareSeriesMarathon({ registry, config, fetchImpl, metadataManifestUrl }),
        ]).then(([subtitleWarning]) => {
          active.subtitleWarning = subtitleWarning;
        }).finally(() => { active.preparing = false; });
        response.writeHead(303, { location: "/session" });
        response.end();
        return;
      }

      if (pathname === "/session" && request.method === "GET") {
        if (!isLoopback(request.socket.remoteAddress)) {
          sendJson(response, 403, { error: "La sesión solo está disponible en el PC." }); return;
        }
        if (!registry.active) { response.writeHead(303, { location: "/watch" }); response.end(); return; }
        const active = registry.active;
        sendHtml(response, 200, activationPage({ watchUrl, active, serverInstanceId,
          preparing: Boolean(active.preparing), subtitleWarning: active.subtitleWarning ?? "" }));
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
        const form = sessionForm;
        const active = registry.setPlaybackSettings({
          subtitleLanguage: form.get("subtitleLanguage"),
          subtitleId: form.get("subtitleId"),
          subtitleDelay: form.get("subtitleDelay"),
        });
        await configStore.save({
          playbackSettings: active.playbackSettings,
        });
        if (!currentSession()) { rejectStale(); return; }
        if (request.headers.accept?.includes("application/json")) {
          sendJson(
            response,
            200,
            playerStatus(registry, serverInstanceId, watchUrl),
          );
        } else {
          sendHtml(
            response,
            200,
            activationPage({ watchUrl, active, serverInstanceId, preparing: Boolean(active.preparing), subtitleWarning: active.subtitleWarning ?? "", settingsSaved: true }),
          );
        }
        return;
      }

      if (url.pathname === "/watch" && request.method === "GET") {
        sendHtml(
          response,
          200,
          watchPage({
            active: registry.active,
            serverInstanceId,
            progressToken,
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
        url.pathname === "/api/marathon/settings" &&
        request.method === "POST"
      ) {
        const form = sessionForm;
        const settings = registry.setMarathonSettings({
          autoplay: form.get("autoplay"),
          countdownSeconds: form.get("countdownSeconds"),
          queueSize: form.get("queueSize"),
        });
        const config = await configStore.save({
          marathonSettings: settings,
        });
        if (!currentSession()) { rejectStale(); return; }
        await fillMarathonQueue({ registry, config, fetchImpl });
        if (!currentSession()) { rejectStale(); return; }
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
        const form = sessionForm;
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
        const form = sessionForm;
        registry.removeMarathonItem(form.get("id"));
        const config = await configStore.load();
        if (!currentSession()) { rejectStale(); return; }
        await fillMarathonQueue({ registry, config, fetchImpl });
        if (!currentSession()) { rejectStale(); return; }
        sendJson(
          response,
          200,
          playerStatus(registry, serverInstanceId, watchUrl),
        );
        return;
      }

      if (pathname === "/api/marathon/undo" && request.method === "POST") {
        registry.undoMarathonRemoval();
        sendJson(response, 200, playerStatus(registry, serverInstanceId, watchUrl));
        return;
      }

      if (
        url.pathname === "/api/marathon/advance" &&
        request.method === "POST"
      ) {
        const form = sessionForm;
        const config = await configStore.load();
        if (!currentSession()) { rejectStale(); return; }
        try {
          registry.advanceMarathon(form.get("id"));
        } catch (error) {
          sendJson(response, 409, {
            error: error.message,
            ...playerStatus(registry, serverInstanceId, watchUrl),
          });
          return;
        }
        sessionActive = registry.active;
        await Promise.all([
          loadActiveSubtitles({
            registry,
            fetchImpl,
            stremioServerUrl,
            subtitlesManifestUrl,
          }),
          fillMarathonQueue({ registry, config, fetchImpl }),
        ]);
        if (!currentSession()) { rejectStale(); return; }
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
        if ((url.searchParams.has("version") && Number(url.searchParams.get("version")) !== registry.active?.version) ||
            (url.searchParams.has("instance") && url.searchParams.get("instance") !== serverInstanceId)) {
          sendJson(response, 409, { error: "La fuente ha cambiado." });
          return;
        }
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
  let cleanup;
  const closeResources = () => {
    if (!cleanup) cleanup = Promise.all([
      Promise.resolve().then(() => subtitleSync.close()),
      Promise.resolve().then(() => speechSetup.close()),
    ]).catch(error => { cleanup = null; throw error; });
    return cleanup;
  };
  // Preserve cleanup for ordinary HTTP server users, while shutdown callers can await it.
  server.once("close", () => { closeResources().catch(() => {}); });
  let shutdown;
  server.shutdown = () => {
    if (!shutdown) shutdown = Promise.all([
      closeResources(),
      new Promise((resolveClose, rejectClose) => server.close(error => {
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") rejectClose(error);
        else resolveClose();
      })),
    ]).catch(error => { shutdown = null; throw error; });
    return shutdown;
  };
  return server;
}
