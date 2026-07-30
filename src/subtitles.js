export const DEFAULT_SUBTITLES_MANIFEST_URL =
  "https://opensubtitles-v3.strem.io/manifest.json";

const LANGUAGE_DETAILS = {
  spa: { language: "es", label: "Español" },
  eng: { language: "en", label: "Inglés" },
  por: { language: "pt", label: "Portugués" },
  fra: { language: "fr", label: "Francés" },
  fre: { language: "fr", label: "Francés" },
  deu: { language: "de", label: "Alemán" },
  ger: { language: "de", label: "Alemán" },
  ita: { language: "it", label: "Italiano" },
};

export function subtitlesResourceUrl(manifestUrl, type, id) {
  if (!["movie", "series"].includes(type)) {
    throw new Error("Tipo de contenido no compatible con subtítulos.");
  }
  const baseUrl = new URL(manifestUrl);
  if (!["http:", "https:"].includes(baseUrl.protocol)) {
    throw new Error("El addon de subtítulos debe usar HTTP o HTTPS.");
  }
  if (!baseUrl.pathname.endsWith("/manifest.json")) {
    throw new Error("La URL del addon de subtítulos no es válida.");
  }
  return new URL(
    `subtitles/${type}/${encodeURIComponent(id)}.json`,
    baseUrl,
  ).toString();
}

export function normalizeSubtitleTracks(subtitles, limit = 80) {
  const seenUrls = new Set();
  const seenIds = new Set();
  const tracks = [];

  for (const [index, subtitle] of (subtitles ?? []).entries()) {
    let url;
    try {
      url = new URL(subtitle?.url);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(url.protocol) || seenUrls.has(url.href)) {
      continue;
    }

    const lang = String(subtitle.lang || "und").toLowerCase();
    const details = LANGUAGE_DETAILS[lang] ?? {
      language: /^[a-z]{2,3}$/i.test(lang) ? lang : "und",
      label: lang === "und" ? "Subtítulos" : lang.toUpperCase(),
    };
    const baseId = String(subtitle.id ?? `${lang}-${index}`);
    let id = baseId;
    let duplicateNumber = 2;
    while (seenIds.has(id)) {
      id = `${baseId}-${duplicateNumber}`;
      duplicateNumber += 1;
    }
    tracks.push({
      id,
      lang,
      ...details,
      url: url.href,
    });
    seenIds.add(id);
    seenUrls.add(url.href);
    if (tracks.length === limit) {
      break;
    }
  }

  return tracks;
}

export function subtitleConversionUrl(
  subtitleUrl,
  stremioServerUrl = "http://127.0.0.1:11470",
) {
  const url = new URL("/subtitles.vtt", stremioServerUrl);
  url.searchParams.set("from", subtitleUrl);
  return url.toString();
}

function timestampSeconds(value) {
  const parts = value.split(":").map(Number);
  const seconds = parts.pop();
  const minutes = parts.pop() ?? 0;
  const hours = parts.pop() ?? 0;
  return hours * 3600 + minutes * 60 + seconds;
}

function formatTimestamp(seconds) {
  const milliseconds = Math.round(Math.max(0, seconds) * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainder = milliseconds % 1000;
  return [hours, minutes, wholeSeconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":")
    .concat(`.${String(remainder).padStart(3, "0")}`);
}

export function shiftWebVtt(content, delaySeconds = 0) {
  const delay = Number(delaySeconds);
  if (!Number.isFinite(delay) || delay === 0) {
    return content;
  }
  return content.replace(
    /(\d{1,2}:\d{2}(?::\d{2})?\.\d{3})\s+-->\s+(\d{1,2}:\d{2}(?::\d{2})?\.\d{3})/g,
    (_match, start, end) =>
      `${formatTimestamp(timestampSeconds(start) + delay)} --> ${formatTimestamp(timestampSeconds(end) + delay)}`,
  );
}
