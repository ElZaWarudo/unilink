import { Readable } from "node:stream";

// Only resources emitted by Stremio's HLS v2 converter may cross this proxy.
export const HLS_RESOURCE = /^(?:master\.m3u8|(?:video|audio|subtitle)\d+\.m3u8|(?:video|audio)\d+\/(?:init\.mp4|segment\d+\.m4s)|subtitle\d+\/segment\d+\.vtt)$/;

export function audioTracksFromPlaylist(playlist) {
  return playlist.split(/\r?\n/).filter(line => /^#EXT-X-MEDIA:TYPE=AUDIO,/.test(line)).map(line => ({
    name: line.match(/(?:[:,])NAME="([^"]*)"/)?.[1] || "",
    lang: line.match(/(?:[:,])LANGUAGE="([^"]*)"/)?.[1] || "",
    default: /(?:[:,])DEFAULT=YES(?:,|$)/.test(line),
  }));
}

export function selectPlaylistAudio(playlist, index) {
  const tracks = audioTracksFromPlaylist(playlist);
  if (!Number.isInteger(index) || index < 0 || index >= tracks.length) throw new Error("Pista de audio no disponible.");
  let current = -1;
  return playlist.split(/\r?\n/).filter(line => !/^#EXT-X-MEDIA:TYPE=AUDIO,/.test(line) || ++current === index)
    .map(line => /^#EXT-X-MEDIA:TYPE=AUDIO,/.test(line) ? line.replace(/DEFAULT=(?:YES|NO)/, "DEFAULT=YES") : line).join("\n");
}

export function rewritePlaylist(playlist, upstreamUrl, localBase) {
  const converterBase = new URL("./", upstreamUrl);
  // Segment playlists live alongside master.m3u8, with segments in track folders.
  const rewrite = (value) => {
    const target = new URL(value, upstreamUrl);
    if (target.origin !== converterBase.origin || !target.pathname.startsWith(converterBase.pathname)) {
      throw new Error("Referencia HLS no permitida.");
    }
    const resource = target.pathname.slice(converterBase.pathname.length);
    if (!HLS_RESOURCE.test(resource)) throw new Error("Recurso HLS no permitido.");
    return `${localBase}${resource}`;
  };
  return playlist.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (line.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${rewrite(uri)}"`);
    return rewrite(line.trim());
  }).join("\n");
}

export async function proxyHls({ request, response, resource, audioIndex, instanceId, version, stremioServerUrl, mediaUrl, fetchImpl }) {
  const converterId = `unilink-${instanceId}-${version}`;
  const upstreamResource = resource === "audio.json" ? "master.m3u8" : resource;
  const upstreamUrl = new URL(`${stremioServerUrl.replace(/\/+$/, "")}/hlsv2/${converterId}/${upstreamResource}`);
  upstreamUrl.searchParams.set("mediaURL", mediaUrl);
  upstreamUrl.searchParams.set("maxAudioChannels", "2");
  upstreamUrl.searchParams.set("audioCodecs", "aac");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  const cancel = () => controller.abort();
  response.once("close", cancel);
  try {
    const upstream = await fetchImpl(upstreamUrl, { signal: controller.signal });
    if (!upstream.ok) throw new Error("Stremio no pudo preparar el audio compatible.");
    if (resource === "audio.json") {
      const tracks = audioTracksFromPlaylist(await upstream.text());
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ tracks }));
      return;
    }
    const playlist = resource.endsWith(".m3u8");
    if (playlist) {
      let original = await upstream.text();
      if (resource === "master.m3u8" && audioIndex !== undefined) original = selectPlaylistAudio(original, audioIndex);
      const body = rewritePlaylist(original, upstreamUrl, `/hls/${instanceId}/${version}/`);
      response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : body);
    } else {
      response.writeHead(200, { "content-type": resource.endsWith(".vtt") ? "text/vtt" : "video/mp4", "cache-control": "no-store" });
      if (request.method === "HEAD" || !upstream.body) {
        await upstream.body?.cancel();
        response.end();
      } else {
        const body = Readable.fromWeb(upstream.body);
        body.on("error", () => response.destroy());
        await new Promise((resolve) => {
          response.once("close", resolve);
          response.once("finish", resolve);
          body.pipe(response);
        });
      }
    }
  } catch {
    if (!response.destroyed && !response.headersSent) {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("No se pudo preparar el audio. Comprueba que Stremio está abierto y actualizado e inténtalo de nuevo.");
    } else if (!response.destroyed) response.destroy();
  } finally {
    clearTimeout(timeout);
    response.off("close", cancel);
    controller.abort();
  }
}
