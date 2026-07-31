import { randomUUID } from "node:crypto";

import {
  normalizeMarathonSettings,
  normalizePlaybackSettings,
} from "./config.js";
import { normalizeSubtitleDelay } from "./subtitle-delay.js";

const INFO_HASH_PATTERN = /^[a-fA-F0-9]{40}$/;
const DEFAULT_TRACKERS = [
  "tracker:udp://tracker.opentrackr.org:1337/announce",
  "tracker:udp://open.stealth.si:80/announce",
  "tracker:udp://tracker.torrent.eu.org:451/announce",
];

function isSupportedSource(source) {
  if (INFO_HASH_PATTERN.test(source?.infoHash ?? "")) {
    return true;
  }
  if (!source?.url) {
    return false;
  }
  try {
    return ["http:", "https:"].includes(new URL(source.url).protocol);
  } catch {
    return false;
  }
}

export class StreamRegistry {
  constructor({
    idFactory = randomUUID,
    maxCandidates = 250,
    playbackSettings = {},
    marathonSettings = {},
  } = {}) {
    this.idFactory = idFactory;
    this.maxCandidates = maxCandidates;
    this.candidates = new Map();
    this.active = null;
    this.version = 0;
    this.playbackDefaults = normalizePlaybackSettings(playbackSettings);
    this.marathonSettings = normalizeMarathonSettings(marathonSettings);
    this.marathon = null;
  }

  setPlaybackDefaults(settings) {
    this.playbackDefaults = normalizePlaybackSettings(settings);
    return this.playbackDefaults;
  }

  setMarathonSettings(settings) {
    this.marathonSettings = normalizeMarathonSettings({
      ...this.marathonSettings,
      ...settings,
    });
    return structuredClone(this.marathonSettings);
  }

  clearMarathon() {
    this.marathon = null;
  }

  setMarathon({ items = [], pending = [], warning = "" } = {}) {
    this.marathon = {
      items: structuredClone(items),
      pending: structuredClone(pending),
      warning: String(warning ?? ""),
    };
    return this.marathonStatus();
  }

  appendMarathonItems(items) {
    if (!this.marathon) {
      this.setMarathon();
    }
    this.marathon.items.push(...structuredClone(items ?? []));
    return this.marathonStatus();
  }

  takePendingMarathonVideos(limit = 1) {
    if (!this.marathon) {
      return [];
    }
    const count = Math.max(0, Math.min(10, Number(limit) || 0));
    return this.marathon.pending.splice(0, count);
  }

  setMarathonWarning(warning = "") {
    if (this.marathon) {
      this.marathon.warning = String(warning);
    }
    return this.marathonStatus();
  }

  moveMarathonItem(id, direction) {
    if (!this.marathon) {
      return this.marathonStatus();
    }
    const index = this.marathon.items.findIndex((item) => item.id === id);
    const offset = Number(direction) < 0 ? -1 : 1;
    const destination = index + offset;
    if (
      index < 0 ||
      destination < 0 ||
      destination >= this.marathon.items.length
    ) {
      return this.marathonStatus();
    }
    const [item] = this.marathon.items.splice(index, 1);
    this.marathon.items.splice(destination, 0, item);
    return this.marathonStatus();
  }

  removeMarathonItem(id) {
    if (this.marathon) {
      this.marathon.items = this.marathon.items.filter(
        (item) => item.id !== id,
      );
    }
    return this.marathonStatus();
  }

  advanceMarathon(expectedId) {
    const item = this.marathon?.items[0];
    const candidateId = item?.candidateIds?.find((id) =>
      this.candidates.has(id),
    );
    if (!item || !candidateId) {
      throw new Error(
        "El siguiente episodio no tiene una fuente preparada.",
      );
    }
    if (expectedId !== undefined && expectedId !== item.id) {
      throw new Error(
        "La cola ha cambiado. Actualiza antes de reproducir el siguiente episodio.",
      );
    }
    const active = this.activate(candidateId);
    this.marathon.items.shift();
    this.marathon.warning = "";
    return active;
  }

  marathonStatus() {
    if (!this.marathon) {
      return null;
    }
    const items = this.marathon.items.map((item) => ({
      id: item.id,
      title: item.title,
      season: item.season,
      episode: item.episode,
      thumbnail: item.thumbnail ?? "",
      released: item.released ?? "",
      prepared: Boolean(
        item.candidateIds?.some((id) => this.candidates.has(id)),
      ),
      sourceCount:
        item.candidateIds?.filter((id) => this.candidates.has(id))
          .length ?? 0,
      error: item.error ?? "",
    }));
    return {
      active: true,
      autoplay: this.marathonSettings.autoplay,
      countdownSeconds: this.marathonSettings.countdownSeconds,
      queueSize: this.marathonSettings.queueSize,
      canAdvance: Boolean(items[0]?.prepared),
      warning: this.marathon.warning,
      items,
    };
  }

  addCandidate(source) {
    if (!isSupportedSource(source)) {
      throw new Error("La fuente no se puede servir en red.");
    }
    const id = this.idFactory();
    this.candidates.set(id, structuredClone(source));
    while (this.candidates.size > this.maxCandidates) {
      const oldest = this.candidates.keys().next().value;
      this.candidates.delete(oldest);
    }
    return id;
  }

  getCandidate(id) {
    return this.candidates.get(id) ?? null;
  }

  activate(id) {
    const source = this.getCandidate(id);
    if (!source) {
      throw new Error("La opción ha caducado. Vuelve a abrir la película en Stremio.");
    }
    this.version += 1;
    this.active = {
      ...structuredClone(source),
      candidateId: id,
      version: this.version,
      activatedAt: new Date().toISOString(),
      playbackSettings: structuredClone(this.playbackDefaults),
    };
    return this.active;
  }

  setSubtitles(subtitles) {
    if (!this.active) {
      throw new Error("No hay ninguna fuente activa.");
    }
    this.active.subtitles = structuredClone(subtitles);
    const current = this.active.playbackSettings ?? {};
    const defaultLanguage =
      subtitles.find((subtitle) => subtitle.language === "es")?.language ??
      subtitles[0]?.language ??
      "";
    const subtitleLanguage = subtitles.some(
      (subtitle) => subtitle.language === current.subtitleLanguage,
    )
      ? current.subtitleLanguage
      : defaultLanguage;
    const tracksForLanguage = subtitles.filter(
      (subtitle) => subtitle.language === subtitleLanguage,
    );
    const preferredSourceIndex =
      Number.isInteger(current.subtitleSourceIndex) &&
      current.subtitleSourceIndex >= 0
        ? current.subtitleSourceIndex
        : 0;
    const selectedSubtitle =
      tracksForLanguage.find(
        (subtitle) => subtitle.id === current.subtitleId,
      ) ??
      tracksForLanguage[preferredSourceIndex] ??
      tracksForLanguage[0];
    const subtitleSourceIndex = Math.max(
      0,
      tracksForLanguage.findIndex(
        (subtitle) => subtitle.id === selectedSubtitle?.id,
      ),
    );

    this.active.playbackSettings = {
      subtitleLanguage,
      subtitleId: selectedSubtitle?.id ?? "",
      subtitleSourceIndex,
      subtitleDelay: current.subtitleDelay ?? 0,
    };
    this.playbackDefaults = structuredClone(
      this.active.playbackSettings,
    );
    return this.active;
  }

  setActiveEpisodeMetadata(video) {
    if (!this.active) {
      throw new Error("No hay ninguna fuente activa.");
    }
    this.active.unilinkEpisode = structuredClone(video);
    return this.active;
  }

  setPlaybackSettings({ subtitleLanguage, subtitleId, subtitleDelay }) {
    if (!this.active) {
      throw new Error("No hay ninguna fuente activa.");
    }
    const subtitles = this.active.subtitles ?? [];
    const languages = new Set(subtitles.map((subtitle) => subtitle.language));
    const currentLanguage =
      this.active.playbackSettings?.subtitleLanguage ?? "";
    const currentSubtitleId =
      this.active.playbackSettings?.subtitleId ?? "";
    const nextLanguage = languages.has(subtitleLanguage)
      ? subtitleLanguage
      : languages.has(currentLanguage)
        ? currentLanguage
        : subtitles[0]?.language ?? "";
    const tracksForLanguage = subtitles.filter(
      (subtitle) => subtitle.language === nextLanguage,
    );
    const requestedSubtitle = tracksForLanguage.find(
      (subtitle) => subtitle.id === subtitleId,
    );
    const currentSubtitle = tracksForLanguage.find(
      (subtitle) => subtitle.id === currentSubtitleId,
    );
    const nextSubtitleId =
      requestedSubtitle?.id ??
      currentSubtitle?.id ??
      tracksForLanguage[0]?.id ??
      "";
    const subtitleSourceIndex = Math.max(
      0,
      tracksForLanguage.findIndex(
        (subtitle) => subtitle.id === nextSubtitleId,
      ),
    );

    if (
      nextLanguage !== currentLanguage ||
      nextSubtitleId !== currentSubtitleId
    ) {
      this.version += 1;
      this.active.version = this.version;
    }
    this.active.playbackSettings = {
      subtitleLanguage: nextLanguage,
      subtitleId: nextSubtitleId,
      subtitleSourceIndex,
      subtitleDelay: normalizeSubtitleDelay(subtitleDelay),
    };
    this.playbackDefaults = structuredClone(
      this.active.playbackSettings,
    );
    return this.active;
  }

  setSubtitleDelay(subtitleDelay) {
    if (!this.active) {
      throw new Error("No hay ninguna fuente activa.");
    }
    const delay = normalizeSubtitleDelay(subtitleDelay);
    const current = this.active.playbackSettings;
    if (current?.subtitleDelay === delay) {
      return this.active;
    }
    this.active.playbackSettings = {
      ...current,
      subtitleDelay: delay,
    };
    this.playbackDefaults = structuredClone(
      this.active.playbackSettings,
    );
    return this.active;
  }
}

function cleanLabel(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function equivalentTorrentDescription(source, originalName) {
  const details =
    cleanLabel(source.description) || cleanLabel(source.title);
  const infoHash = cleanLabel(source.infoHash);
  const fingerprint = INFO_HASH_PATTERN.test(infoHash)
    ? `#${infoHash.slice(0, 8).toLowerCase()}`
    : "";

  const torrent = details || originalName;
  const relation = ["Torrent equivalente", fingerprint]
    .filter(Boolean)
    .join(" · ");
  return [torrent, relation].filter(Boolean).join("\n");
}

export function decorateTorrentioStreams(
  streams,
  { activationBaseUrl, registry, content },
) {
  return streams
    .filter(isSupportedSource)
    .slice(0, registry.maxCandidates)
    .map((source) => {
      const candidateId = registry.addCandidate({
        ...source,
        ...(content ? { unilinkContent: content } : {}),
      });
      const originalName = cleanLabel(source.name) || "Torrentio";

      return {
        name: `📡 Servir · ${originalName}`,
        description: equivalentTorrentDescription(source, originalName),
        externalUrl: new URL(
          `/activate/${encodeURIComponent(candidateId)}`,
          activationBaseUrl,
        ).toString(),
      };
    });
}

export function buildStremioSourceUrl(
  source,
  stremioServerUrl = "http://127.0.0.1:11470",
) {
  if (source.url) {
    const url = new URL(source.url);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("La fuente directa no usa HTTP(S).");
    }
    return url.toString();
  }

  if (!INFO_HASH_PATTERN.test(source.infoHash ?? "")) {
    throw new Error("Torrentio devolvió un infoHash no válido.");
  }

  const fileIdx =
    Number.isInteger(source.fileIdx) && source.fileIdx >= 0
      ? source.fileIdx
      : -1;
  const url = new URL(stremioServerUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${source.infoHash.toLowerCase()}/${fileIdx}`;
  url.search = "";
  const trackers =
    Array.isArray(source.sources) && source.sources.length
      ? source.sources
      : [...DEFAULT_TRACKERS, `dht:${source.infoHash.toLowerCase()}`];
  for (const tracker of trackers) {
    url.searchParams.append("tr", tracker);
  }
  return url.toString();
}
