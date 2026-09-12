export function createProgressReporter({ token, version, serverInstanceId, fetchImpl = fetch,
  now = Date.now, onState = () => {} }) {
  let lastAttempt = -Infinity;
  let inFlight = 0;
  let stopped = false;
  async function send(progress) {
    inFlight++;
    lastAttempt = now();
    try {
      const response = await fetchImpl("/api/progress", {
        method: "POST", headers: { "content-type": "application/json", "x-unilink-token": token },
        body: JSON.stringify({ ...progress, version, serverInstanceId }),
        keepalive: true, signal: AbortSignal.timeout(35000),
      });
      if (response.status === 409) { stopped = true; return; }
      if (!response.ok) throw new Error("Progress request failed");
      const result = await response.json();
      onState(result.state);
    } catch { onState("error"); }
    finally {
      inFlight--;
    }
  }
  return {
    report(time, duration, force = false) {
      if (!token || stopped || !Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0) return;
      const progress = { time, duration };
      if (inFlight && !force) return;
      if (!force && now() - lastAttempt < 15000) return;
      return send(progress);
    },
  };
}

function timestampSeconds(value) {
  const parts = String(value).trim().replace(",", ".").split(":");
  if (parts.length < 2 || parts.length > 3) {
    return Number.NaN;
  }
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = parts.length ? Number(parts.pop()) : 0;
  return hours * 3600 + minutes * 60 + seconds;
}

function cleanCueText(value) {
  return value
    .replace(/<[^>]*>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/&#(\d+);/g, (_match, code) =>
      String.fromCodePoint(Number(code)),
    )
    .trim();
}

export function parseWebVtt(content) {
  const normalized = String(content ?? "")
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  const cues = [];

  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) {
      continue;
    }

    const timing = lines[timingIndex].match(
      /^\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})\s+-->\s+(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})/,
    );
    if (!timing) {
      continue;
    }

    const start = timestampSeconds(timing[1]);
    const end = timestampSeconds(timing[2]);
    const text = cleanCueText(lines.slice(timingIndex + 1).join("\n"));
    if (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      end > start &&
      text
    ) {
      cues.push({ start, end, text });
    }
  }

  return cues.sort((left, right) => left.start - right.start);
}

export function cueAtTime(cues, currentTime, delaySeconds = 0) {
  const delay = Number(delaySeconds);
  const mediaTime =
    Number(currentTime) - (Number.isFinite(delay) ? delay : 0);
  let low = 0;
  let high = cues.length - 1;
  let candidate = -1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (cues[middle].start <= mediaTime) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (candidate < 0 || mediaTime >= cues[candidate].end) {
    return null;
  }
  return cues[candidate];
}

export function resumeTime(value, duration) {
  const time = Number(value);
  const total = Number(duration);
  if (
    !Number.isFinite(time) ||
    !Number.isFinite(total) ||
    time < 1 ||
    total <= 0 ||
    time >= total - 10
  ) {
    return null;
  }
  return time;
}

export function seekTargetTime(currentTime, duration, offsetSeconds) {
  const current = Number(currentTime);
  const offset = Number(offsetSeconds);
  const total = Number(duration);
  if (!Number.isFinite(current) || !Number.isFinite(offset)) {
    return 0;
  }
  const maximum =
    Number.isFinite(total) && total > 0 ? total : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(maximum, current + offset));
}

export function shouldReloadPlayer(
  status,
  { version, serverInstanceId },
) {
  if (Number(status?.version) !== Number(version)) {
    return true;
  }

  const expectedInstance = String(serverInstanceId ?? "");
  const currentInstance = String(status?.serverInstanceId ?? "");
  return Boolean(
    expectedInstance &&
      currentInstance &&
      expectedInstance !== currentInstance,
  );
}

export function shouldStartMarathonCountdown({
  ended,
  autoplay,
  canAdvance,
  itemCount,
}) {
  return Boolean(
    ended &&
      autoplay &&
      canAdvance &&
      Number(itemCount) > 0,
  );
}

function formatClock(value) {
  if (!Number.isFinite(value) || value < 0) {
    return "0:00";
  }
  const total = Math.floor(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const minuteText =
    hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return `${hours > 0 ? `${hours}:` : ""}${minuteText}:${String(seconds).padStart(2, "0")}`;
}

function numericDelay(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const CONTROLS_HIDE_DELAY = 3000;
const DOUBLE_TAP_DELAY = 340;
const SEEK_STEP = 10;

function audioLanguage(track) {
  const language = track.lang || track.language || "";
  return ({ spa: "es", eng: "en", fra: "fr", fre: "fr", ger: "de", deu: "de", ita: "it", por: "pt", jpn: "ja" })[language] || language;
}

export function audioTrackLabel(track, index) {
  let language = audioLanguage(track);
  try {
    language = new Intl.DisplayNames(["es"], { type: "language" }).of(language);
  } catch { /* Older TV browsers can still show the language code. */ }
  const name = track.name || track.label || "";
  const details = name && name !== track.lang && name !== track.language ? name : "";
  const label = [language, details, `Pista ${index + 1}`].filter(Boolean).join(" · ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function preferredAudioTrack(tracks, preference) {
  if (!preference?.lang) return -1;
  const exact = tracks.findIndex(track => audioLanguage(track) === audioLanguage(preference) && (track.name || track.label || "") === preference.name);
  return exact >= 0 ? exact : tracks.findIndex(track => audioLanguage(track) === audioLanguage(preference));
}

export function startAudioPlayback({ video, select, url, onError, onRecovered = () => {}, onTrackChange = () => {}, Hls = globalThis.Hls, fetchImpl = fetch }) {
  let hls;
  let disposed = false;
  let pendingError = null;
  let recoveryAttempted = false;
  let recoveryPosition = null;
  let tracks = [];
  let preference;
  try { preference = JSON.parse(localStorage.getItem("unilink:audio") || "null"); } catch { /* Playback works without storage. */ }
  let nativeTracks = [];
  let nativeIndex = -1;
  let nativeResume = null;
  const controller = new AbortController();
  const render = () => {
    if (disposed || !select) return;
    tracks = hls ? hls.audioTracks : nativeTracks;
    select.replaceChildren();
    for (const [index, track] of tracks.entries()) {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = audioTrackLabel(track, index);
      select.append(option);
    }
    if (!tracks.length) {
      const option = document.createElement("option");
      option.textContent = "Sin pistas seleccionables";
      select.append(option);
    }
    select.disabled = tracks.length < 2;
    sync();
  };
  const sync = () => {
    const index = hls ? hls.audioTrack : nativeIndex;
    if (select && index >= 0) select.value = String(index);
    if (!disposed && index >= 0 && tracks[index]) onTrackChange({ index, language: audioLanguage(tracks[index]) });
  };
  const choose = (index) => {
    if (index < 0 || index >= tracks.length) return;
    if (hls) hls.audioTrack = index;
    else if (nativeIndex !== index) {
      nativeResume = {
        time: nativeResume?.time ?? (video.currentTime || 0),
        playing: nativeResume?.playing || !video.paused,
      };
      nativeIndex = index;
      video.src = `${url}?audio=${index}`;
      sync();
    }
  };
  const applyPreference = () => {
    render();
    choose(preferredAudioTrack(tracks, preference));
    sync();
  };
  const change = () => {
    const index = Number(select.value);
    if (!Number.isInteger(index) || !tracks[index]) return;
    choose(index);
    preference = { lang: audioLanguage(tracks[index]), name: tracks[index].name || tracks[index].label || "" };
    try { localStorage.setItem("unilink:audio", JSON.stringify(preference)); } catch { /* Optional preference. */ }
  };
  select?.addEventListener("change", change);
  const restoreNativePosition = () => {
    if (!nativeResume) return;
    const { time, playing } = nativeResume;
    nativeResume = null;
    if (time > 0) video.currentTime = time;
    if (playing) video.play().catch(() => onError("Pulsa Reproducir para continuar con la pista elegida."));
  };
  const recover = () => {
    if (disposed || !hls || !pendingError || recoveryAttempted) return;
    const error = pendingError;
    if (!["networkError", "mediaError"].includes(error.type)) return;
    pendingError = null;
    recoveryAttempted = true;
    recoveryPosition = video.currentTime;
    if (error.type === "mediaError") {
      const wasPlaying = !video.paused;
      hls.recoverMediaError();
      hls.startLoad(recoveryPosition);
      if (wasPlaying) video.play().catch(error => {
        if (!disposed && error.name !== "AbortError") onError("Pulsa Reproducir para continuar.");
      });
    }
    else if (["manifestLoadError", "manifestLoadTimeOut", "manifestParsingError"].includes(error.details)) {
      hls.loadSource(url);
      hls.startLoad(recoveryPosition);
    } else hls.startLoad(recoveryPosition);
  };
  const recoveredProgress = () => {
    if (recoveryPosition === null || video.paused || video.currentTime <= recoveryPosition + 1) return;
    recoveryPosition = null;
    recoveryAttempted = false;
    pendingError = null;
    render();
    onRecovered();
  };
  video.addEventListener("play", recover);
  video.addEventListener("timeupdate", recoveredProgress);
  if (Hls?.isSupported()) {
    hls = new Hls({ enableWorker: false, backBufferLength: 30, maxBufferLength: 20 });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, applyPreference);
    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, sync);
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal && !disposed) {
        hls.stopLoad();
        recoveryPosition = null;
        pendingError = data;
        if (!video.paused && !recoveryAttempted && ["networkError", "mediaError"].includes(data.type)) {
          recover();
          return;
        }
        if (select) select.disabled = true;
        onError("No se pudo reproducir con audio compatible. Comprueba que Stremio sigue abierto y actualizado, y pulsa Reintentar.");
      }
    });
    hls.loadSource(url);
    hls.attachMedia(video);
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.addEventListener("loadedmetadata", restoreNativePosition);
    fetchImpl(url.replace(/master\.m3u8$/, "audio.json"), { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error("No se pudieron obtener las pistas.");
        return response.json();
      })
      .then(({ tracks: available }) => {
        if (disposed) return;
        nativeTracks = available;
        render();
        const preferred = preferredAudioTrack(tracks, preference);
        if (tracks.length) choose(preferred >= 0 ? preferred : Math.max(0, tracks.findIndex(track => track.default)));
        else video.src = url;
      })
      .catch(() => { if (!disposed) onError("No se pudieron preparar las pistas de audio. Comprueba Stremio y pulsa Reintentar."); });
  } else {
    onError("Este navegador no admite la reproducción con audio compatible. Usa un navegador con soporte HLS o MediaSource.");
  }
  return {
    resume() {
      recoveryAttempted = false;
      recover();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      hls?.destroy();
      select?.removeEventListener("change", change);
      video.removeEventListener("loadedmetadata", restoreNativePosition);
      video.removeEventListener("play", recover);
      video.removeEventListener("timeupdate", recoveredProgress);
    },
  };
}

export function isEnglishLanguage(language) {
  return /^(en|eng|english)([-_].*)?$/i.test(String(language || ""));
}

// Apply whole cues inside verified bounds. Trim conflicting boundary cues back
// to their original timing until a safe gap, retaining the aligned interior.
export function alignedSubtitleCues(cues, corrections) {
  const valid = corrections.slice(-32).filter(item =>
    [item.start, item.end, item.offset].every(Number.isFinite) && item.end > item.start);
  const shifted = cues.map(cue => {
    const item = valid.findLast(item => cue.start >= item.start && cue.end <= item.end);
    return !item || !item.offset ? cue : { ...cue, start: cue.start + item.offset, end: cue.end + item.offset };
  });
  const pending = cues.map((_cue, index) => index);
  const revert = index => {
    if (index < 0 || index >= cues.length || shifted[index] === cues[index]) return;
    shifted[index] = cues[index];
    pending.push(index, index + 1);
  };
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const index = pending[cursor];
    if (index >= cues.length) continue;
    if (shifted[index].start < 0) revert(index);
    if (!index) continue;
    const gap = Math.min(0, cues[index].start - cues[index - 1].end);
    if (shifted[index].start < shifted[index - 1].start ||
        shifted[index].start - shifted[index - 1].end < gap - 0.000001) {
      revert(index); revert(index - 1);
    }
  }
  return shifted;
}

  export function createSubtitleSyncController({ token, fetchImpl = fetch, onChange = () => {},
    setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let context = {}, enabled = false, disposed = false, generation = 0;
  let jobId = null, timer = null, busy = false, corrections = [], state = "off";
  let attempted = new Set(), retryAfter = 0, position = 0, duration = 0, pendingBucket = null;
  const headers = { "content-type": "application/json", "x-unilink-token": token };
  const eligible = () => context.captions && isEnglishLanguage(context.subtitleLanguage) &&
    Number.isInteger(context.audioIndex) && context.audioIndex >= 0 &&
    (!context.audioLanguage || /^(und|unknown)$/i.test(context.audioLanguage) || isEnglishLanguage(context.audioLanguage));
  const emit = next => { state = next; onChange({ state, enabled, eligible: Boolean(eligible()), corrections }); };
  const cancelJob = id => {
    if (id) fetchImpl(`/api/subtitle-sync?job=${encodeURIComponent(id)}`, { method: "DELETE", headers }).catch(() => {});
  };
  const cancel = () => {
    if (pendingBucket !== null) attempted.delete(pendingBucket);
    pendingBucket = null;
    generation++; clearTimer(timer); timer = null; busy = false;
    cancelJob(jobId); jobId = null;
  };
  async function request(path, options = {}) {
    const response = await fetchImpl(path, { ...options, headers, signal: AbortSignal.timeout(15000) });
    const payload = await response.json();
    if (!response.ok && !["unavailable", "busy", "stale", "error", "insufficient"].includes(payload.state))
      throw new Error("Subtitle synchronization failed");
    return payload;
  }
  async function run(time, bucket, epoch, poll = false) {
    pendingBucket = bucket;
    busy = true;
    try {
      const result = await request(poll ? `/api/subtitle-sync?job=${encodeURIComponent(jobId)}` : "/api/subtitle-sync", poll ? {} : {
        method: "POST", body: JSON.stringify({ serverInstanceId: context.serverInstanceId, version: context.version,
            subtitleUrl: context.subtitleUrl, audioIndex: context.audioIndex, time, duration,
            requestId: `${clientId}:${epoch}:${bucket}` }),
      });
      if (epoch !== generation || disposed || !enabled) {
        if (result.state === "working") cancelJob(result.jobId);
        return;
      }
      jobId = result.jobId || null;
        if (result.state === "working") {
          if (state !== "working") emit("working");
        timer = setTimer(() => { timer = null; run(time, bucket, epoch, true); }, 1000);
      } else {
        pendingBucket = null;
        jobId = null;
        if (result.state === "ready" && result.result &&
            [result.result.start, result.result.end, result.result.offset].every(Number.isFinite) &&
            result.result.end > result.result.start) {
          corrections = [...corrections, result.result].slice(-32);
          emit("ready");
        } else if (result.state === "busy") {
          attempted.delete(bucket); retryAfter = now() + 10000; emit("busy");
        } else emit(["insufficient", "unavailable", "stale"].includes(result.state) ? result.state : "error");
      }
    } catch {
      if (epoch === generation && !disposed && enabled) { pendingBucket = null; cancelJob(jobId); jobId = null; emit("error"); }
    } finally { if (epoch === generation) busy = false; }
  }
  const controller = {
    setContext(next) {
      if (JSON.stringify(next) === JSON.stringify(context)) return;
      cancel(); context = { ...next }; corrections = []; attempted = new Set(); enabled = false; emit("off");
    },
    async setEnabled(value) {
      cancel(); corrections = []; attempted = new Set(); retryAfter = 0;
      enabled = Boolean(value && eligible() && !disposed);
      if (!enabled) { emit("off"); return; }
      const epoch = generation; busy = true; emit("working");
      try {
        const capability = await request("/api/subtitle-sync");
        if (epoch !== generation || disposed || !enabled) return;
        busy = false;
        if (!capability.available) { emit("unavailable"); return; }
        emit("waiting"); controller.tick(position, duration);
      } catch { if (epoch === generation && !disposed) { busy = false; emit("error"); } }
    },
    tick(time, total) {
      position = Number(time); duration = Number(total);
      if (!enabled || disposed || busy || timer || !eligible() || now() < retryAfter ||
          ["error", "unavailable", "stale"].includes(state) || !Number.isFinite(position) ||
          !Number.isFinite(duration) || duration <= 0) return;
      const coverage = corrections.findLast(item => position >= item.start + item.offset && position < item.end + item.offset);
      let target = position;
      if (coverage) {
        if (position < coverage.end + coverage.offset - 25) { if (state !== "ready") emit("ready"); return; }
        target = Math.min(duration - 1, coverage.end + coverage.offset + 1);
      } else if (state === "ready") emit("waiting");
      const bucket = Math.floor(target / 60);
      if (attempted.has(bucket)) return;
        while (attempted.size >= 32) attempted.delete(attempted.values().next().value);
        attempted.add(bucket); emit("working"); run(target, bucket, generation);
    },
    seek(time, total) {
      cancel(); controller.tick(time, total);
    },
    destroy() { cancel(); disposed = true; enabled = false; corrections = []; emit("off"); },
  };
  return controller;
}

export function startPlayer(root) {
  const video = root.querySelector("video");
  const caption = root.querySelector('[data-player-part="caption"]');
  const message = root.querySelector('[data-player-part="message"]');
  const seekFeedback = root.querySelector(
    '[data-player-part="seek-feedback"]',
  );
  const playButton = root.querySelector('[data-player-control="play"]');
  const seek = root.querySelector('[data-player-control="seek"]');
  const clock = root.querySelector('[data-player-part="clock"]');
  const muteButton = root.querySelector('[data-player-control="mute"]');
  const volume = root.querySelector('[data-player-control="volume"]');
  const audioSelect = root.querySelector('[data-player-control="audio"]');
  const syncButton = root.querySelector('[data-player-control="subtitle-sync"]');
  const syncStatus = root.querySelector('[data-player-part="subtitle-sync-status"]');
  const retryButton = root.querySelector('[data-player-control="retry"]');
  const captionsButton = root.querySelector(
    '[data-player-control="captions"]',
  );
  const fullscreenButton = root.querySelector(
    '[data-player-control="fullscreen"]',
  );
  const controls = root.querySelector(".player-controls");
  const delayState = document.querySelector("[data-subtitle-delay-state]");
  const marathonRoot = document.querySelector("[data-marathon]");
  const marathonList = marathonRoot?.querySelector(
    "[data-marathon-list]",
  );
  const marathonWarning = marathonRoot?.querySelector(
    "[data-marathon-warning]",
  );
  const marathonToggle = marathonRoot?.querySelector(
    '[data-marathon-action="toggle-autoplay"]',
  );
  const marathonAdvance = marathonRoot?.querySelector(
    '[data-marathon-action="advance"]',
  );
  const marathonCountdown = marathonRoot?.querySelector(
    "[data-marathon-countdown]",
  );
  const marathonCountdownText = marathonRoot?.querySelector(
    "[data-marathon-countdown-text]",
  );
  let subtitleUrl = root.dataset.subtitleUrl;
  const expectedVersion = Number(root.dataset.version);
  const expectedServerInstanceId =
    root.dataset.serverInstanceId || "";
  const statusUrl = root.dataset.statusUrl || "/api/status";
  const resumeKey = root.dataset.resumeKey
    ? `unilink:position:${root.dataset.resumeKey}`
    : "";

  if (
    !video ||
    !caption ||
    !message ||
    !seekFeedback ||
    !playButton ||
    !seek ||
    !clock ||
    !muteButton ||
    !volume ||
    !captionsButton ||
    !fullscreenButton ||
    !controls
  ) {
    return null;
  }

  let cues = [];
  let subtitleDelay = numericDelay(root.dataset.subtitleDelay);
  let captionsEnabled = Boolean(subtitleUrl);
  let captionsLoaded = false;
  let subtitleLoadGeneration = 0;
  let animationFrame = 0;
  let lastCaption = "";
  let positionRestored = false;
  let hasPlayed = !video.paused;
  const progressStatus = document.querySelector("[data-stremio-progress]");
  const progressReporter = createProgressReporter({
    token: root.dataset.progressToken,
    version: expectedVersion, serverInstanceId: expectedServerInstanceId,
    onState(state) {
      if (!progressStatus) return;
      progressStatus.textContent = state === "synced" ? "Progreso guardado en Stremio" :
        state === "disconnected" ? "Conecta Stremio en la configuración del PC para guardar el progreso en tu cuenta" :
        "Progreso pendiente de guardar en Stremio. Se reintentará automáticamente.";
    },
  });
  let lastSavedPosition = 0;
  let controlsTimer = 0;
  let keyboardInteraction = true;
  let controlsPointerDown = false;
  let surfaceTapTimer = 0;
  let feedbackTimer = 0;
  let lastSurfaceTap = null;
  let marathonState = null;
  let marathonFingerprint = "";
  let marathonBusy = false;
  let marathonCountdownTimer = 0;
  let marathonCountdownRemaining = 0;
  let playbackFailure = "";
  let actualAudio = { index: null, language: "" };
  let syncedCues = [], syncEnabled = false;
  const subtitleSync = createSubtitleSyncController({
    token: root.dataset.progressToken,
    onChange({ state, enabled, eligible, corrections }) {
      syncEnabled = enabled;
      syncedCues = enabled ? alignedSubtitleCues(cues, corrections) : cues;
      if (syncButton) {
        syncButton.disabled = !eligible;
        syncButton.setAttribute("aria-pressed", String(enabled));
      }
      if (syncStatus) {
        const latest = corrections.at(-1);
        const boundaryRejected = state === "ready" && latest?.offset && cues.some(cue =>
          cue.start >= latest.start && cue.end <= latest.end) && !cues.some((cue, index) =>
          cue.start >= latest.start && cue.end <= latest.end && syncedCues[index].start !== cue.start);
        const labels = {
          off: eligible ? "" : "Requiere subtítulos y audio en inglés",
          waiting: "Esperando diálogo…", working: "Sincronizando este tramo…",
          ready: "Tramo sincronizado", insufficient: "Sin coincidencia fiable; se conserva el tiempo original",
          busy: "Motor ocupado; se reintentará", unavailable: "Activa el motor local en el PC",
          error: "No se pudo sincronizar. Desactiva y activa para reintentar",
          stale: "La fuente ha cambiado. Desactiva y activa para reintentar",
        };
        const text = boundaryRejected ? "No se puede ajustar este tramo sin solapar subtítulos" : labels[state] || "";
        if (syncStatus.textContent !== text) syncStatus.textContent = text;
      }
      renderCaption();
    },
  });
  function updateSyncContext() {
    subtitleSync.setContext({ version: expectedVersion, serverInstanceId: expectedServerInstanceId,
      subtitleUrl, subtitleLanguage: root.dataset.subtitleLanguage,
      audioIndex: actualAudio.index, audioLanguage: actualAudio.language,
      captions: captionsEnabled && captionsLoaded });
  }

  video.controls = false;
  root.classList.add("is-enhanced");
  root.dataset.controlsState = "visible";

  function isFullscreen() {
    return document.fullscreenElement === root;
  }

  function controlsHaveFocus() {
    return controls.contains(document.activeElement) &&
      (keyboardInteraction || document.activeElement.tagName === "SELECT");
  }

  function clearControlsTimer() {
    clearTimeout(controlsTimer);
    controlsTimer = 0;
  }

  function hideControls() {
    clearControlsTimer();
    if (controlsPointerDown || controlsHaveFocus()) {
      return;
    }
    root.classList.add("is-controls-hidden");
    root.dataset.controlsState = "hidden";
  }

  function scheduleControlsHide() {
    clearControlsTimer();
    if (controlsPointerDown || controlsHaveFocus()) {
      return;
    }
    controlsTimer = setTimeout(hideControls, CONTROLS_HIDE_DELAY);
  }

  function showControls({ schedule = true } = {}) {
    clearControlsTimer();
    root.classList.remove("is-controls-hidden");
    root.dataset.controlsState = "visible";
    if (schedule) {
      scheduleControlsHide();
    }
  }

  function setMessage(text = "") {
    text = playbackFailure || text;
    message.textContent = text;
    message.hidden = !text;
  }

  function marathonButton(action, label, item, disabled = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.marathonAction = action;
    button.dataset.marathonId = item.id;
    button.textContent = label;
    button.disabled = disabled;
    const actionLabel = {
      "move-up": "Subir",
      "move-down": "Bajar",
      remove: "Quitar",
    }[action];
    button.setAttribute("aria-label", `${actionLabel} ${item.title}`);
    return button;
  }

  function renderMarathon(state) {
    if (!marathonRoot || !marathonList || !state) {
      return;
    }
    const fingerprint = JSON.stringify(state);
    if (fingerprint === marathonFingerprint) {
      marathonState = state;
      return;
    }
    marathonFingerprint = fingerprint;
    marathonState = state;
    marathonRoot.hidden = false;
    if (marathonToggle) {
      marathonToggle.textContent = state.autoplay
        ? "Parar después de este episodio"
        : "Activar reproducción automática";
      marathonToggle.setAttribute(
        "aria-pressed",
        String(Boolean(state.autoplay)),
      );
      marathonToggle.disabled = marathonBusy;
    }
    if (marathonAdvance) {
      marathonAdvance.disabled =
        marathonBusy || !state.canAdvance;
    }
    if (marathonWarning) {
      marathonWarning.textContent = state.warning ?? "";
      marathonWarning.hidden = !state.warning;
    }
    marathonList.replaceChildren();
    if (!state.items?.length) {
      const empty = document.createElement("li");
      empty.className = "marathon-empty";
      empty.textContent = "No hay más episodios preparados.";
      marathonList.append(empty);
      return;
    }
    state.items.forEach((item, index) => {
      const row = document.createElement("li");
      row.className =
        `marathon-item${item.prepared ? "" : " is-unavailable"}`;
      row.dataset.marathonItem = item.id;

      const content = document.createElement("div");
      const title = document.createElement("strong");
      title.className = "marathon-item-title";
      title.textContent = item.title;
      const meta = document.createElement("span");
      meta.className = "marathon-item-meta";
      const availability = item.prepared
        ? `${item.sourceCount} ${item.sourceCount === 1 ? "fuente preparada" : "fuentes preparadas"}`
        : item.error || "Fuente no disponible";
      meta.textContent =
        `T${item.season} · E${item.episode} · ${availability}`;
      content.append(title, meta);

      const actions = document.createElement("div");
      actions.className = "marathon-item-actions";
      actions.append(
        marathonButton("move-up", "↑", item, index === 0),
        marathonButton(
          "move-down",
          "↓",
          item,
          index === state.items.length - 1,
        ),
        marathonButton("remove", "Quitar", item),
      );
      row.append(content, actions);
      marathonList.append(row);
    });
  }

  function cancelMarathonCountdown(messageText = "") {
    clearInterval(marathonCountdownTimer);
    marathonCountdownTimer = 0;
    marathonCountdownRemaining = 0;
    if (marathonCountdown) {
      marathonCountdown.hidden = true;
    }
    if (messageText) {
      setMessage(messageText);
    }
  }

  function updateMarathonCountdown() {
    if (marathonCountdownText) {
      const nextTitle =
        marathonState?.items?.[0]?.title ?? "el siguiente episodio";
      marathonCountdownText.textContent =
        `Siguiente: ${nextTitle}. Reproducción en ${marathonCountdownRemaining} s.`;
    }
  }

  async function postForm(path, values = {}) {
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(values)) {
      body.set(name, String(value));
    }
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function updateDelayState() {
    root.dataset.currentDelay = String(subtitleDelay);
    if (delayState) {
      const sign = subtitleDelay > 0 ? "+" : "";
      delayState.textContent =
        `Sincronización ${sign}${subtitleDelay.toFixed(2).replace(".", ",")} s`;
    }
  }

  async function advanceMarathon() {
    if (marathonBusy || !marathonState?.canAdvance) {
      return;
    }
    marathonBusy = true;
    cancelMarathonCountdown();
    setMessage("Preparando el siguiente episodio…");
    if (marathonAdvance) {
      marathonAdvance.disabled = true;
    }
    try {
      await postForm("/api/marathon/advance", {
        id: marathonState.items[0].id,
      });
      location.reload();
    } catch {
      marathonBusy = false;
      setMessage(
        "No se pudo abrir el siguiente episodio. Revisa la cola e inténtalo de nuevo.",
      );
      if (marathonAdvance) {
        marathonAdvance.disabled = !marathonState?.canAdvance;
      }
    }
  }

  function startMarathonCountdown() {
    if (
      !shouldStartMarathonCountdown({
        ended: video.ended,
        autoplay: marathonState?.autoplay,
        canAdvance: marathonState?.canAdvance,
        itemCount: marathonState?.items?.length,
      })
    ) {
      return;
    }
    cancelMarathonCountdown();
    marathonCountdownRemaining = Math.max(
      3,
      Number(marathonState.countdownSeconds) || 10,
    );
    if (marathonCountdown) {
      marathonCountdown.hidden = false;
    }
    updateMarathonCountdown();
    marathonCountdownTimer = setInterval(() => {
      marathonCountdownRemaining -= 1;
      if (marathonCountdownRemaining <= 0) {
        cancelMarathonCountdown();
        advanceMarathon();
        return;
      }
      updateMarathonCountdown();
    }, 1000);
  }

  async function handleMarathonAction(event) {
    const button = event.target.closest?.("[data-marathon-action]");
    if (!button || !marathonRoot?.contains(button) || marathonBusy) {
      return;
    }
    const action = button.dataset.marathonAction;
    if (action === "cancel-countdown") {
      cancelMarathonCountdown("Cuenta atrás cancelada.");
      return;
    }
    if (action === "advance") {
      await advanceMarathon();
      return;
    }
    marathonBusy = true;
    try {
      let result;
      if (action === "toggle-autoplay") {
        cancelMarathonCountdown();
        result = await postForm("/api/marathon/settings", {
          autoplay: !marathonState?.autoplay,
          countdownSeconds:
            marathonState?.countdownSeconds ?? 10,
          queueSize: marathonState?.queueSize ?? 5,
        });
      } else if (action === "move-up" || action === "move-down") {
        result = await postForm("/api/marathon/move", {
          id: button.dataset.marathonId,
          direction: action === "move-up" ? -1 : 1,
        });
      } else if (action === "remove") {
        result = await postForm("/api/marathon/remove", {
          id: button.dataset.marathonId,
        });
      }
      marathonBusy = false;
      marathonFingerprint = "";
      if (result?.marathon) {
        renderMarathon(result.marathon);
      }
    } catch {
      marathonBusy = false;
      setMessage("No se pudo actualizar la cola de episodios.");
      marathonFingerprint = "";
      renderMarathon(marathonState);
    }
  }

  function storedPosition() {
    if (!resumeKey) {
      return null;
    }
    try {
      return localStorage.getItem(resumeKey);
    } catch {
      return null;
    }
  }

  function restorePosition() {
    if (positionRestored) {
      return;
    }
    positionRestored = true;
    const restored = resumeTime(storedPosition(), video.duration);
    if (restored === null) {
      root.dataset.resumeState = "fresh";
      return;
    }
    video.currentTime = restored;
    lastSavedPosition = restored;
    root.dataset.resumeState = "restored";
    updateClock();
    renderCaption();
  }

  function savePosition(force = false) {
    if (hasPlayed && positionRestored && video.readyState >= 2 && !video.seeking) {
      progressReporter.report(video.currentTime, video.duration, force);
    }
    if (!resumeKey || !positionRestored) {
      return;
    }
    if (video.ended) {
      try {
        localStorage.removeItem(resumeKey);
      } catch {
        // Storage can be disabled by the browser.
      }
      return;
    }
    if (
      !Number.isFinite(video.currentTime) ||
      video.currentTime < 1 ||
      (!force && Math.abs(video.currentTime - lastSavedPosition) < 2)
    ) {
      return;
    }
    try {
      localStorage.setItem(resumeKey, String(video.currentTime));
      lastSavedPosition = video.currentTime;
      root.dataset.resumeState = "saved";
    } catch {
      root.dataset.resumeState = "unavailable";
    }
  }

  function renderCaption() {
    const activeCue =
      captionsEnabled && captionsLoaded
        ? cueAtTime(syncEnabled ? syncedCues : cues, video.currentTime, subtitleDelay)
        : null;
    const nextCaption = activeCue?.text ?? "";
    if (nextCaption === lastCaption) {
      return;
    }
    lastCaption = nextCaption;
    caption.textContent = nextCaption;
    caption.hidden = !nextCaption;
  }

  function updateClock() {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const progress = duration ? (video.currentTime / duration) * 1000 : 0;
    seek.value = String(Math.max(0, Math.min(1000, progress)));
    clock.textContent = `${formatClock(video.currentTime)} / ${formatClock(duration)}`;
  }

  function showSeekFeedback(offsetSeconds, side) {
    clearTimeout(feedbackTimer);
    const sign = offsetSeconds < 0 ? "−" : "+";
    seekFeedback.textContent = `${sign}${Math.abs(offsetSeconds)} s`;
    seekFeedback.dataset.side = side;
    seekFeedback.classList.remove("is-visible");
    void seekFeedback.offsetWidth;
    seekFeedback.classList.add("is-visible");
    feedbackTimer = setTimeout(() => {
      seekFeedback.classList.remove("is-visible");
      seekFeedback.textContent = "";
    }, 800);
  }

  function seekBy(offsetSeconds, side) {
    video.currentTime = seekTargetTime(
      video.currentTime,
      video.duration,
      offsetSeconds,
    );
    updateClock();
    renderCaption();
    savePosition(true);
    showSeekFeedback(offsetSeconds, side);
    showControls();
  }

  function updatePlayButton() {
    const playing = !video.paused && !video.ended;
    playButton.textContent = playing ? "Ⅱ" : "▶";
    playButton.setAttribute(
      "aria-label",
      playing ? "Pausar" : "Reproducir",
    );
    playButton.title = playing ? "Pausar (espacio)" : "Reproducir (espacio)";
  }

  function updateVolume() {
    volume.value = String(video.volume);
    muteButton.textContent = video.muted || video.volume === 0 ? "MUDO" : "VOL";
    muteButton.setAttribute(
      "aria-label",
      video.muted ? "Activar sonido" : "Silenciar",
    );
  }

  function tick() {
    updateClock();
    renderCaption();
    if (!video.paused && !video.ended) {
      animationFrame = requestAnimationFrame(tick);
    }
  }

  function startTicking() {
    cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(tick);
  }

  async function togglePlayback() {
    if (video.paused || video.ended) {
      audioPlayback?.resume();
      try {
        await video.play();
      } catch (error) {
        if (error.name !== "AbortError") {
          setMessage("No se pudo reanudar. Pulsa Reproducir otra vez o Reintentar.");
          if (retryButton) retryButton.hidden = false;
        }
      }
    } else {
      video.pause();
    }
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (root.requestFullscreen) {
      await root.requestFullscreen();
    } else if (video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
    }
  }

  function surfaceSide(clientX) {
    const bounds = root.getBoundingClientRect();
    return clientX < bounds.left + bounds.width / 2
      ? "backward"
      : "forward";
  }

  function handleSurfacePointerUp(event) {
    if (
      event.button !== 0 ||
      event.target?.closest?.(".player-controls")
    ) {
      return;
    }

    const now = performance.now();
    const side = surfaceSide(event.clientX);
    const isDoubleTap =
      Boolean(lastSurfaceTap) &&
      lastSurfaceTap?.pointerType === event.pointerType &&
      (event.pointerType !== "touch" || lastSurfaceTap?.side === side) &&
      now - lastSurfaceTap.time <= DOUBLE_TAP_DELAY;

    clearTimeout(surfaceTapTimer);
    if (isDoubleTap) {
      event.preventDefault();
      lastSurfaceTap = null;
      if (event.pointerType === "touch") {
        seekBy(side === "backward" ? -SEEK_STEP : SEEK_STEP, side);
      } else {
        toggleFullscreen().catch(() => setMessage("No se pudo cambiar a pantalla completa."));
      }
      return;
    }

    lastSurfaceTap = { side, time: now, pointerType: event.pointerType };
    surfaceTapTimer = setTimeout(() => {
      lastSurfaceTap = null;
      togglePlayback();
    }, DOUBLE_TAP_DELAY);
  }

  async function loadSubtitles(nextUrl = subtitleUrl) {
    const previousUrl = subtitleUrl;
    subtitleUrl = String(nextUrl ?? "");
    root.dataset.subtitleUrl = subtitleUrl;
    const generation = ++subtitleLoadGeneration;
    cues = [];
    captionsLoaded = false;
    updateSyncContext();
    renderCaption();
    if (!subtitleUrl) {
      captionsEnabled = false;
      captionsButton.disabled = true;
      captionsButton.setAttribute("aria-label", "Subtítulos no disponibles");
      captionsButton.setAttribute("aria-pressed", "false");
      if (delayState) {
        delayState.textContent = "Sin subtítulos";
      }
      return;
    }

    if (!previousUrl) {
      captionsEnabled = true;
      captionsButton.setAttribute("aria-pressed", "true");
    }

    captionsButton.disabled = true;
    captionsButton.title = "Cargando subtítulos";
    try {
      const response = await fetch(subtitleUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const nextCues = parseWebVtt(await response.text());
      if (generation !== subtitleLoadGeneration) {
        return;
      }
      cues = nextCues;
      captionsLoaded = cues.length > 0;
      updateSyncContext();
      captionsButton.disabled = !captionsLoaded;
      captionsButton.title = captionsLoaded
        ? "Activar o desactivar subtítulos (C)"
        : "Subtítulos no disponibles";
      root.dataset.subtitleState = captionsLoaded ? "ready" : "empty";
      renderCaption();
      updateDelayState();
    } catch {
      if (generation !== subtitleLoadGeneration) {
        return;
      }
      captionsLoaded = false;
      captionsButton.disabled = true;
      captionsButton.title = "No se pudieron cargar los subtítulos";
      root.dataset.subtitleState = "error";
      if (delayState) {
        delayState.textContent = "Error de subtítulos";
      }
    }
  }

  async function pollStatus() {
    try {
      const response = await fetch(statusUrl, { cache: "no-store" });
      if (!response.ok) {
        return;
      }
      const status = await response.json();
      if (
        shouldReloadPlayer(status, {
          version: expectedVersion,
          serverInstanceId: expectedServerInstanceId,
        })
      ) {
        subtitleSync.destroy();
        location.reload();
        return;
      }
      if (status.marathon) {
        renderMarathon(status.marathon);
        if (!status.marathon.autoplay) {
          cancelMarathonCountdown();
        }
      }
      if (status.subtitleLanguage !== undefined && status.subtitleLanguage !== root.dataset.subtitleLanguage) {
        root.dataset.subtitleLanguage = status.subtitleLanguage;
        updateSyncContext();
      }
      if (String(status.subtitleUrl ?? "") !== subtitleUrl) {
        loadSubtitles(status.subtitleUrl);
      }
      const nextDelay = numericDelay(status.subtitleDelay);
      if (nextDelay !== subtitleDelay) {
        subtitleDelay = nextDelay;
        updateDelayState();
        renderCaption();
      }
    } catch {
      // A transient status failure must not interrupt playback.
    }
  }

  playButton.addEventListener("click", () => {
    togglePlayback();
    showControls();
  });
  root.addEventListener("pointerup", handleSurfacePointerUp);
  root.addEventListener("dblclick", (event) => {
    if (!event.target?.closest?.(".player-controls")) {
      event.preventDefault();
    }
  });
  root.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return;
    if (!keyboardInteraction && document.activeElement?.tagName === "SELECT" &&
        controls.contains(document.activeElement) && !controls.contains(event.target)) {
      document.activeElement.blur();
    }
    showControls();
  });
  root.addEventListener("pointerdown", () => {
    keyboardInteraction = false;
  }, { capture: true });
  controls.addEventListener("change", (event) => {
    if (!keyboardInteraction && event.target.tagName === "SELECT") {
      event.target.blur();
      showControls();
    }
  });
  controls.addEventListener("pointerdown", () => {
    controlsPointerDown = true;
    showControls({ schedule: false });
  });
  const finishControlsPointer = () => {
    if (!controlsPointerDown) return;
    controlsPointerDown = false;
    scheduleControlsHide();
  };
  window.addEventListener("pointerup", finishControlsPointer);
  window.addEventListener("pointercancel", finishControlsPointer);
  const handleKeyboardInteraction = () => {
    keyboardInteraction = true;
    if (root.contains(document.activeElement)) showControls();
  };
  document.addEventListener("keydown", handleKeyboardInteraction, true);
  controls.addEventListener("focusin", () => {
    showControls();
  });
  controls.addEventListener("focusout", () => {
    setTimeout(scheduleControlsHide);
  });
  video.addEventListener("play", () => {
    hasPlayed = true;
    cancelMarathonCountdown();
    setMessage();
    updatePlayButton();
    startTicking();
  });
  video.addEventListener("pause", () => {
    cancelAnimationFrame(animationFrame);
    updatePlayButton();
    updateClock();
    renderCaption();
    savePosition(true);
  });
  video.addEventListener("ended", () => {
    updatePlayButton();
    savePosition(true);
    startMarathonCountdown();
  });
  video.addEventListener("loadedmetadata", () => {
    restorePosition();
    updateClock();
  });
  video.addEventListener("durationchange", updateClock);
  video.addEventListener("timeupdate", () => {
    subtitleSync.tick(video.currentTime, video.duration);
    updateClock();
    renderCaption();
    savePosition();
  });
  video.addEventListener("seeked", renderCaption);
  const syncSeek = () => subtitleSync.seek(video.currentTime, video.duration);
  video.addEventListener("seeking", syncSeek);
  video.addEventListener("waiting", () => setMessage("Cargando vídeo…"));
  video.addEventListener("playing", () => setMessage());
  video.addEventListener("canplay", () => setMessage());
  video.addEventListener("error", () => {
    if (retryButton) retryButton.hidden = false;
    setMessage(
      "No se pudo reproducir esta fuente. Pulsa Reintentar; si continúa, elige otra en Stremio.",
    );
  });

  seek.addEventListener("input", () => {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = (Number(seek.value) / 1000) * video.duration;
      updateClock();
      renderCaption();
    }
  });

  muteButton.addEventListener("click", () => {
    video.muted = !video.muted;
    updateVolume();
  });
  volume.addEventListener("input", () => {
    video.volume = Number(volume.value);
    video.muted = video.volume === 0;
    updateVolume();
  });
  video.addEventListener("volumechange", updateVolume);

  captionsButton.addEventListener("click", () => {
    captionsEnabled = !captionsEnabled;
    captionsButton.setAttribute("aria-pressed", String(captionsEnabled));
    updateSyncContext();
    renderCaption();
  });
  const toggleSync = () => {
    subtitleSync.tick(video.currentTime, video.duration);
    subtitleSync.setEnabled(!syncEnabled);
  };
  syncButton?.addEventListener("click", toggleSync);
  marathonRoot?.addEventListener("click", handleMarathonAction);

  fullscreenButton.addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", () => {
    const fullscreen = isFullscreen();
    fullscreenButton.setAttribute(
      "aria-label",
      fullscreen ? "Salir de pantalla completa" : "Pantalla completa",
    );
    showControls();
  });

  root.addEventListener("keydown", (event) => {
    if (["BUTTON", "INPUT", "SELECT"].includes(event.target.tagName)) {
      return;
    }
    showControls();
    const key = event.key.toLowerCase();
    if (key === " " || key === "k") {
      event.preventDefault();
      togglePlayback();
    } else if (key === "arrowleft") {
      event.preventDefault();
      seekBy(-SEEK_STEP, "backward");
    } else if (key === "arrowright") {
      event.preventDefault();
      seekBy(SEEK_STEP, "forward");
    } else if (key === "m") {
      video.muted = !video.muted;
    } else if (key === "c" && captionsLoaded) {
      captionsButton.click();
    } else if (key === "f") {
      toggleFullscreen();
    }
  });

  if (!root.requestFullscreen && !video.webkitEnterFullscreen) {
    fullscreenButton.hidden = true;
  }

  updatePlayButton();
  showControls();
  updateVolume();
  updateClock();
  updateDelayState();
  if (video.readyState >= 1) {
    restorePosition();
  }
  if (video.error) {
    setMessage(
      "Este navegador no puede reproducir esta fuente. Elige otra en Stremio.",
    );
  } else if (video.readyState >= 3) {
    setMessage();
  } else {
    setMessage("Preparando vídeo…");
  }
  loadSubtitles();
  const audioPlayback = root.dataset.hlsUrl ? startAudioPlayback({
    video,
    select: audioSelect,
    url: root.dataset.hlsUrl,
    onTrackChange(track) { actualAudio = track; updateSyncContext(); },
    onError(text) {
      playbackFailure = text;
      setMessage(text);
      if (retryButton) retryButton.hidden = false;
    },
    onRecovered() {
      playbackFailure = "";
      setMessage();
      if (retryButton) retryButton.hidden = true;
    },
  }) : null;
  const retryPlayback = () => { savePosition(true); window.location.reload(); };
  retryButton?.addEventListener("click", retryPlayback);
  pollStatus();
  const statusTimer = setInterval(pollStatus, 1000);
  const saveOnExit = () => { savePosition(true); subtitleSync.destroy(); audioPlayback?.destroy(); };
  window.addEventListener("pagehide", saveOnExit);
  const restoreAfterCache = (event) => { if (event.persisted) window.location.reload(); };
  window.addEventListener("pageshow", restoreAfterCache);

  return {
    destroy() {
      subtitleSync.destroy();
      syncButton?.removeEventListener("click", toggleSync);
      video.removeEventListener("seeking", syncSeek);
      audioPlayback?.destroy();
      retryButton?.removeEventListener("click", retryPlayback);
      clearInterval(statusTimer);
      clearControlsTimer();
      window.removeEventListener("pointerup", finishControlsPointer);
      window.removeEventListener("pointercancel", finishControlsPointer);
      document.removeEventListener("keydown", handleKeyboardInteraction, true);
      clearTimeout(surfaceTapTimer);
      clearTimeout(feedbackTimer);
      cancelMarathonCountdown();
      cancelAnimationFrame(animationFrame);
      marathonRoot?.removeEventListener(
        "click",
        handleMarathonAction,
      );
      window.removeEventListener("pagehide", saveOnExit);
      window.removeEventListener("pageshow", restoreAfterCache);
      savePosition(true);
    },
    pollStatus,
    renderCaption,
  };
}

function boot() {
  for (const player of document.querySelectorAll("[data-unilink-player]")) {
    startPlayer(player);
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
}
