export const DEFAULT_METADATA_MANIFEST_URL =
  "https://v3-cinemeta.strem.io/manifest.json";

const SERIES_VIDEO_ID_PATTERN = /^(tt\d+):(\d+):(\d+)$/i;
const PREFERENCE_GROUPS = [
  ["2160p", "4k"],
  ["1080p"],
  ["720p"],
  ["480p"],
  ["web-dl", "webdl"],
  ["webrip", "web-rip"],
  ["bluray", "blu-ray", "brrip"],
  ["h264", "x264", "avc"],
  ["h265", "x265", "hevc"],
  ["av1"],
  ["hdr", "hdr10"],
  ["dolby vision", "dovi", " dv "],
  ["aac"],
  ["ac3", "dd5.1"],
  ["eac3", "e-ac3", "ddp"],
  ["dts"],
  ["atmos"],
];

function sourceText(source) {
  return [
    source?.name,
    source?.title,
    source?.description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[._[\]()]+/g, " ")
    .replace(/\s+/g, " ");
}

function preferenceSignature(source) {
  const text = ` ${sourceText(source)} `;
  return PREFERENCE_GROUPS.map((variants) =>
    variants.some((variant) => text.includes(variant)),
  );
}

export function parseSeriesVideoId(value) {
  const match = String(value ?? "").match(SERIES_VIDEO_ID_PATTERN);
  if (!match) {
    return null;
  }
  const season = Number(match[2]);
  const episode = Number(match[3]);
  if (season < 1 || episode < 1) {
    return null;
  }
  return {
    imdbId: match[1].toLowerCase(),
    season,
    episode,
    videoId: `${match[1].toLowerCase()}:${season}:${episode}`,
  };
}

export function metadataResourceUrl(
  manifestUrl,
  imdbId,
) {
  const parsedId = String(imdbId ?? "").toLowerCase();
  if (!/^tt\d+$/.test(parsedId)) {
    throw new Error("El ID IMDb de la serie no es válido.");
  }
  const baseUrl = new URL(manifestUrl);
  if (!["http:", "https:"].includes(baseUrl.protocol)) {
    throw new Error("El addon de metadatos debe usar HTTP o HTTPS.");
  }
  if (!baseUrl.pathname.endsWith("/manifest.json")) {
    throw new Error("La URL del addon de metadatos no es válida.");
  }
  return new URL(
    `meta/series/${encodeURIComponent(parsedId)}.json`,
    baseUrl,
  ).toString();
}

export function seriesQueueVideos(
  videos,
  currentVideoId,
  { limit = 5 } = {},
) {
  const current = parseSeriesVideoId(currentVideoId);
  if (!current) {
    return [];
  }
  const normalized = (videos ?? [])
    .map((video) => {
      const parsed = parseSeriesVideoId(video?.id);
      if (!parsed || parsed.imdbId !== current.imdbId) {
        return null;
      }
      return {
        id: parsed.videoId,
        title:
          String(video.title ?? "").trim() ||
          `Temporada ${parsed.season} · Episodio ${parsed.episode}`,
        season: parsed.season,
        episode: parsed.episode,
        thumbnail: String(video.thumbnail ?? "").trim(),
        released: String(video.released ?? "").trim(),
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) =>
        left.season - right.season ||
        left.episode - right.episode,
    );
  const currentIndex = normalized.findIndex(
    (video) => video.id === current.videoId,
  );
  const following =
    currentIndex >= 0
      ? normalized.slice(currentIndex + 1)
      : normalized.filter(
          (video) =>
            video.season > current.season ||
            (video.season === current.season &&
              video.episode > current.episode),
        );
  const safeLimit = Math.max(0, Math.min(500, Number(limit) || 0));
  return following.slice(0, safeLimit);
}

export function rankMarathonStreams(currentSource, candidates) {
  const currentSignature = preferenceSignature(currentSource);
  return (candidates ?? [])
    .map((source, index) => {
      const signature = preferenceSignature(source);
      let score = 0;
      for (const [groupIndex, present] of signature.entries()) {
        if (present && currentSignature[groupIndex]) {
          score += 5;
        } else if (present !== currentSignature[groupIndex]) {
          score -= 1;
        }
      }
      if (source?.url) {
        score += 1;
      }
      return { source, index, score };
    })
    .sort(
      (left, right) =>
        right.score - left.score || left.index - right.index,
    )
    .map(({ source }) => source);
}
