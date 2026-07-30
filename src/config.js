import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_MARATHON_SETTINGS = {
  autoplay: true,
  countdownSeconds: 10,
  queueSize: 5,
};

export function normalizeTorrentioManifestUrl(input) {
  const value = String(input ?? "").trim();
  if (!value) {
    throw new Error("La URL de Torrentio es obligatoria.");
  }

  const normalized = value.replace(/^stremio:\/\//i, "https://");
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("La URL de Torrentio no es válida.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("La URL de Torrentio debe usar HTTP o HTTPS.");
  }
  if (!url.pathname.endsWith("/manifest.json")) {
    throw new Error("La URL de Torrentio debe terminar en manifest.json.");
  }

  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function torrentioResourceUrl(manifestUrl, type, id) {
  if (!["movie", "series"].includes(type)) {
    throw new Error("Tipo de contenido no compatible.");
  }
  const normalized = normalizeTorrentioManifestUrl(manifestUrl);
  return new URL(
    `stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`,
    normalized,
  ).toString();
}

export function normalizePlaybackSettings(settings) {
  if (!settings || typeof settings !== "object") {
    return null;
  }
  const subtitleSourceIndex = Number(settings.subtitleSourceIndex);
  const subtitleDelay = Number(settings.subtitleDelay);
  return {
    subtitleLanguage: String(settings.subtitleLanguage ?? "")
      .trim()
      .toLowerCase(),
    subtitleId: String(settings.subtitleId ?? "").trim(),
    subtitleSourceIndex:
      Number.isInteger(subtitleSourceIndex) && subtitleSourceIndex >= 0
        ? subtitleSourceIndex
        : 0,
    subtitleDelay: Number.isFinite(subtitleDelay)
      ? Math.max(-30, Math.min(30, subtitleDelay))
      : 0,
  };
}

export function normalizeMarathonSettings(settings = {}) {
  const countdownSeconds = Number(settings?.countdownSeconds);
  const queueSize = Number(settings?.queueSize);
  const autoplayValue = settings?.autoplay;
  return {
    autoplay: ![
      false,
      0,
      "0",
      "false",
      "off",
      "no",
    ].includes(autoplayValue),
    countdownSeconds: Number.isFinite(countdownSeconds)
      ? Math.max(3, Math.min(30, Math.round(countdownSeconds)))
      : DEFAULT_MARATHON_SETTINGS.countdownSeconds,
    queueSize: Number.isFinite(queueSize)
      ? Math.max(1, Math.min(10, Math.round(queueSize)))
      : DEFAULT_MARATHON_SETTINGS.queueSize,
  };
}

export class ConfigStore {
  constructor(path) {
    this.path = path;
  }

  async load() {
    try {
      const content = await readFile(this.path, "utf8");
      const parsed = JSON.parse(content);
      const config = {};
      if (parsed.torrentioManifestUrl) {
        config.torrentioManifestUrl = normalizeTorrentioManifestUrl(
          parsed.torrentioManifestUrl,
        );
      }
      const playbackSettings = normalizePlaybackSettings(
        parsed.playbackSettings,
      );
      if (playbackSettings) {
        config.playbackSettings = playbackSettings;
      }
      if (parsed.marathonSettings) {
        config.marathonSettings = normalizeMarathonSettings(
          parsed.marathonSettings,
        );
      }
      return config;
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  async save(config) {
    const current = await this.load();
    const merged = { ...current, ...config };
    const normalized = {};
    if (merged.torrentioManifestUrl) {
      normalized.torrentioManifestUrl = normalizeTorrentioManifestUrl(
        merged.torrentioManifestUrl,
      );
    }
    const playbackSettings = normalizePlaybackSettings(
      merged.playbackSettings,
    );
    if (playbackSettings) {
      normalized.playbackSettings = playbackSettings;
    }
    if (merged.marathonSettings) {
      normalized.marathonSettings = normalizeMarathonSettings(
        merged.marathonSettings,
      );
    }
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(normalized, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, this.path);
    return normalized;
  }
}
