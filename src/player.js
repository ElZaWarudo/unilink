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

export function createSubtitleSyncReporter({ token, getSnapshot, fetchImpl = fetch,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let sequence = 0, timer = null, inFlight = false, pending = null, stopped = false, rejectedContext = null;
  let observedContext = null, generation = 0;
  const contextKey = value => JSON.stringify([value.serverInstanceId, value.version, value.subtitleUrl]);
  const observe = value => {
    const key = contextKey(value);
    if (key !== observedContext) { observedContext = key; generation++; rejectedContext = null; }
    return { value, epoch: generation };
  };
  const heartbeat = () => {
    if (stopped || !token || timer !== null) return;
    timer = setTimer(() => { timer = null; reporter.report(); heartbeat(); }, 3000);
  };
  async function send({ value, epoch }) {
    inFlight = true;
    let delivered = false;
    try {
      const response = await fetchImpl("/api/subtitle-sync/playback", {
        method: "POST", headers: { "content-type": "application/json", "x-unilink-token": token },
        body: JSON.stringify({ ...value, clientId, sequence: ++sequence }),
        keepalive: true, signal: AbortSignal.timeout(10000),
      });
      delivered = response.ok;
      if (response.status === 409 && epoch === generation) rejectedContext = contextKey(value);
    } catch { /* The next heartbeat retries a failed delivery. */ }
    finally {
      inFlight = false;
      const next = pending; pending = null;
      if (next && (delivered || stopped || next.epoch !== epoch)) send(next);
    }
  }
  const reporter = {
    report() {
      if (!token || stopped) return;
      heartbeat();
      const value = { ...getSnapshot() };
      const report = observe(value);
      if (!value.subtitleUrl || contextKey(value) === rejectedContext) return;
      if (inFlight) pending = report;
      else send(report);
    },
    destroy() {
      if (stopped) return;
      stopped = true; clearTimer(timer); timer = null;
      if (!token) return;
      const value = { ...getSnapshot(), enabled: false, state: "off", automaticOffset: 0, manualBaseline: 0 };
      const report = observe(value);
      if (!value.subtitleUrl || contextKey(value) === rejectedContext) return;
      if (inFlight) pending = report;
      else send(report);
    },
  };
  return reporter;
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
  if (language === "und" || language === "unknown") language = "";
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
  let recoveryFrames = null;
  let resumeAfterAttach = false;
  const renderedFrames = () => {
    try {
      const quality = video.getVideoPlaybackQuality?.();
      if (quality && Number.isFinite(quality.totalVideoFrames) && Number.isFinite(quality.droppedVideoFrames))
        return Math.max(0, quality.totalVideoFrames - quality.droppedVideoFrames);
      if (Number.isFinite(video.webkitDecodedFrameCount)) return video.webkitDecodedFrameCount;
    } catch { /* Older TV browsers may not expose frame counters. */ }
    return null;
  };
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
  const captureRecovery = () => {
    if (recoveryPosition !== null) return;
    recoveryPosition = video.currentTime;
    recoveryFrames = renderedFrames();
    resumeAfterAttach = !video.paused;
  };
  const attached = () => {
    if (disposed || recoveryPosition === null || !resumeAfterAttach) return;
    resumeAfterAttach = false;
    video.play().catch(error => {
      if (!disposed && error.name !== "AbortError") onError("Pulsa Reproducir para continuar.");
    });
  };
  const failRecovery = (error) => {
    hls.stopLoad();
    video.pause?.();
    recoveryPosition = null;
    resumeAfterAttach = false;
    pendingError = error;
    if (select) select.disabled = true;
    onError("No se pudo reproducir con audio compatible. Comprueba que Stremio sigue abierto y actualizado, y pulsa Reintentar.");
  };
  const recover = (explicitResume = false) => {
    if (disposed || !hls || !pendingError || recoveryAttempted) return;
    const error = pendingError;
    if (!["networkError", "mediaError"].includes(error.type)) return;
    pendingError = null;
    recoveryAttempted = true;
    captureRecovery();
    if (explicitResume === true) resumeAfterAttach = true;
    if (error.type === "mediaError") {
      hls.recoverMediaError();
      hls.startLoad(recoveryPosition);
      if (!Hls.Events.MEDIA_ATTACHED) attached();
    }
    else if (["manifestLoadError", "manifestLoadTimeOut", "manifestParsingError"].includes(error.details)) {
      hls.loadSource(url);
      hls.startLoad(recoveryPosition);
    } else hls.startLoad(recoveryPosition);
  };
  const recoveredProgress = () => {
    if (recoveryPosition === null || video.paused || video.currentTime <= recoveryPosition + 1) return;
    if (video.videoWidth === 0) return;
    const frames = renderedFrames();
    if (frames !== null) {
      if (recoveryFrames === null || frames < recoveryFrames) recoveryFrames = 0;
      if (frames <= recoveryFrames) return;
    }
    recoveryPosition = null;
    recoveryAttempted = false;
    pendingError = null;
    resumeAfterAttach = false;
    render();
    onRecovered();
  };
  video.addEventListener("play", recover);
  video.addEventListener("timeupdate", recoveredProgress);
  if (Hls?.isSupported()) {
    hls = new Hls({ enableWorker: false, backBufferLength: 30, maxBufferLength: 20 });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, applyPreference);
    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, sync);
    if (Hls.Events.MEDIA_ATTACHED) hls.on(Hls.Events.MEDIA_ATTACHED, attached);
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (disposed) return;
      // ErrorController in hls.js 1.7.2 has already reset MediaSource before
      // this listener. The native error snapshot survives that detach/attach.
      const resetMediaSourceFlag = 16; // hls.js 1.7.2 ErrorActionFlags.ResetMediaSource.
      const libraryReset = data.details === "mediaSourceRequiresReset" || (data.errorAction?.flags & resetMediaSourceFlag);
      if (libraryReset) {
        if (recoveryAttempted) { failRecovery(data); return; }
        captureRecovery();
        recoveryAttempted = true;
        pendingError = null;
        // ErrorController stops loading after a fatal reset; restart loading
        // at the saved position without performing a second MediaSource reset.
        if (data.fatal) hls.startLoad(recoveryPosition);
        return;
      }
      if (data.fatal && !disposed) {
        hls.stopLoad();
        pendingError = data;
        if ((!video.paused || resumeAfterAttach) && !recoveryAttempted && ["networkError", "mediaError"].includes(data.type)) {
          recover();
          return;
        }
        failRecovery(data);
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
    nativeError() {
      if (!hls || disposed) return;
      if (video.error?.code !== 3) {
        recoveryAttempted = true;
        failRecovery({ type: "otherError", details: "nativeMediaError" });
        return;
      }
      const error = { type: "mediaError", details: "nativeMediaError" };
      if (recoveryAttempted) { failRecovery(error); return; }
      captureRecovery();
      pendingError = error;
    },
    pause() { resumeAfterAttach = false; },
    resume() {
      if (recoveryPosition !== null && !pendingError) {
        resumeAfterAttach = true;
        return;
      }
      recoveryAttempted = false;
      recover(true);
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

export function appliedSubtitleOffset(corrections) {
  return corrections.findLast(item =>
    [item.start, item.end, item.offset].every(Number.isFinite) && item.end > item.start)?.offset ?? 0;
}

// Keep one reference across the track until a newer reliable match replaces it.
// A uniform shift preserves cue gaps and avoids artificial section boundaries.
export function alignedSubtitleCues(cues, corrections) {
  const offset = appliedSubtitleOffset(corrections);
  return !offset ? cues : cues.map(cue => ({ ...cue,
    start: cue.start + offset, end: cue.end + offset,
  }));
}

export function createSubtitleSyncController({ token, fetchImpl = fetch, onChange = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let context = {}, enabled = false, disposed = false, contextStale = false, generation = 0;
  let jobId = null, timer = null, busy = false, corrections = [], state = "off";
  let stage = null, elapsedMs = 0;
  let attempted = new Map(), failures = 0, requestSequence = 0, position = 0, duration = 0, pendingBucket = null;
  const headers = { "content-type": "application/json", "x-unilink-token": token };
  const eligible = () => context.captions && isEnglishLanguage(context.subtitleLanguage) &&
    Number.isInteger(context.audioIndex) && context.audioIndex >= 0 &&
    (!context.audioLanguage || /^(und|unknown)$/i.test(context.audioLanguage) || isEnglishLanguage(context.audioLanguage));
  const emit = (next, progress = {}) => {
    state = next;
    stage = next === "working" ? progress.stage || null : null;
    elapsedMs = next === "working" && Number.isFinite(progress.elapsedMs) ? Math.max(0, progress.elapsedMs) : 0;
    onChange({ state, stage, elapsedMs, enabled, eligible: Boolean(eligible()), corrections });
  };
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
  const retry = (next, epoch) => {
    if (pendingBucket !== null) attempted.delete(pendingBucket);
    pendingBucket = null;
    cancelJob(jobId); jobId = null;
    emit(next);
    const delay = Math.min(30000, (next === "busy" ? 10000 : 2000) * 2 ** Math.min(failures++, 4));
    timer = setTimer(() => {
      if (epoch !== generation || disposed || !enabled) return;
      timer = null;
      checkCapability(epoch);
    }, delay);
  };
  async function checkCapability(epoch) {
    busy = true;
    try {
      const capability = await request("/api/subtitle-sync");
      if (epoch !== generation || disposed || !enabled) return;
      if (capability.state === "stale") { contextStale = true; emit("stale"); return; }
      if (!capability.available) { retry("unavailable", epoch); return; }
      busy = false; emit("waiting"); controller.tick(position, duration);
    } catch {
      if (epoch === generation && !disposed && enabled) retry("error", epoch);
    } finally { if (epoch === generation && state !== "working") busy = false; }
  }
  async function run(time, bucket, epoch, poll = false) {
    pendingBucket = bucket;
    busy = true;
    try {
      const result = await request(poll ? `/api/subtitle-sync?job=${encodeURIComponent(jobId)}` : "/api/subtitle-sync", poll ? {} : {
        method: "POST", body: JSON.stringify({ serverInstanceId: context.serverInstanceId, version: context.version,
            subtitleUrl: context.subtitleUrl, audioIndex: context.audioIndex, time, duration,
            requestId: `${clientId}:${epoch}:${bucket}:${++requestSequence}` }),
      });
      if (epoch !== generation || disposed || !enabled) {
        if (result.state === "working") cancelJob(result.jobId);
        return;
      }
      if (result.state === "working" && result.jobId) {
        jobId = result.jobId;
        if (state !== "working" || stage !== (result.stage || null) || elapsedMs !== (result.elapsedMs || 0)) emit("working", result);
        timer = setTimer(() => {
          if (epoch !== generation || disposed || !enabled) return;
          timer = null; run(time, bucket, epoch, true);
        }, 1000);
      } else {
        if (result.state === "ready" && result.result &&
            [result.result.start, result.result.end, result.result.offset].every(Number.isFinite) &&
            result.result.end > result.result.start && Math.abs(result.result.offset) <= 120) {
          attempted.set(bucket, "ready"); pendingBucket = null; jobId = null; failures = 0;
          corrections = [...corrections, result.result].slice(-32);
          emit("ready");
        } else if (["insufficient", "stale"].includes(result.state)) {
          attempted.set(bucket, result.state); pendingBucket = null; jobId = null; failures = 0;
          if (result.state === "stale") contextStale = true;
          emit(result.state);
        } else retry(["busy", "unavailable"].includes(result.state) ? result.state : "error", epoch);
      }
    } catch {
      if (epoch === generation && !disposed && enabled) retry("error", epoch);
    } finally { if (epoch === generation) busy = false; }
  }
  const controller = {
    setContext(next) {
      if (JSON.stringify(next) === JSON.stringify(context)) return;
      cancel(); context = { ...next }; corrections = []; attempted = new Map(); failures = 0; contextStale = false; enabled = false; emit("off");
    },
    async setEnabled(value) {
      cancel(); corrections = []; attempted = new Map(); failures = 0;
      enabled = Boolean(value && eligible() && !disposed && !contextStale);
      if (!enabled) { emit(value && contextStale ? "stale" : "off"); return; }
      emit("working");
      await checkCapability(generation);
    },
    tick(time, total) {
      position = Number(time); duration = Number(total);
      if (!enabled || disposed || busy || timer || !eligible() ||
          ["error", "unavailable", "stale"].includes(state) || !Number.isFinite(position) ||
          !Number.isFinite(duration) || duration <= 0) return;
      const coverage = corrections.findLast(item => position >= item.start + item.offset && position < item.end + item.offset);
      let target = position;
      if (coverage) {
        if (position < coverage.end + coverage.offset - 25) { if (state !== "ready") emit("ready"); return; }
        target = Math.min(duration - 1, coverage.end + coverage.offset + 1);
      } else if (state === "ready") emit("waiting");
      const bucket = Math.floor(target / 60);
      if (attempted.has(bucket)) {
        const settled = coverage ? "ready" : attempted.get(bucket) === "insufficient" ? "insufficient" : "waiting";
        if (state !== settled) emit(settled);
        return;
      }
      while (attempted.size >= 32) attempted.delete(attempted.keys().next().value);
      attempted.set(bucket, "working"); emit("working"); run(target, bucket, generation);
    },
    seek(time, total) {
      cancel();
      position = Number(time); duration = Number(total);
      if (enabled && ["error", "unavailable", "busy"].includes(state)) { checkCapability(generation); return; }
      if (enabled && state === "working") emit("waiting");
      controller.tick(time, total);
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
  const subtitleRetry = root.querySelector('[data-player-control="subtitle-retry"]');
  const captionsButton = root.querySelector(
    '[data-player-control="captions"]',
  );
  const fullscreenButton = root.querySelector(
    '[data-player-control="fullscreen"]',
  );
  const controls = root.querySelector(".player-controls");
  const delayState = document.querySelector("[data-subtitle-delay-state]");
  const marathonRoot = document.querySelector("[data-marathon]");
  const marathonOperation = marathonRoot?.querySelector("[data-marathon-operation]");
  const marathonUndo = marathonRoot?.querySelector('[data-marathon-action="undo"]');
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
  let subtitleController;
  let statusController;
  let disposed = false;
  const mutationControllers = new Set();
  let animationFrame = 0;
  let lastCaption = "";
  let positionRestored = false;
  let hasPlayed = !video.paused;
  const progressStatus = document.querySelector("[data-stremio-progress]");
  const localProgress = document.querySelector("[data-local-progress]");
  const subtitleStatus = document.querySelector("[data-subtitle-status]");
  const progressReporter = createProgressReporter({
    token: root.dataset.progressToken,
    version: expectedVersion, serverInstanceId: expectedServerInstanceId,
    onState(state) {
      if (!progressStatus) return;
      progressStatus.textContent = ({
        synced: "Progreso guardado en Stremio.",
        disconnected: "Conecta Stremio en la configuración del PC para guardar el progreso en tu cuenta.",
        unsupported: "Este contenido no admite guardar el progreso en Stremio.",
        pending: "Stremio aún no ha confirmado el guardado del progreso.",
        error: "No se pudo guardar el progreso en Stremio. Se reintentará durante la reproducción.",
      })[state] || "Stremio no ha confirmado el guardado del progreso.";
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
  let marathonFocus = null;
  let lastClock = "";
  let marathonRevision = 0;
  let marathonCountdownTimer = 0;
  let marathonCountdownRemaining = 0;
  let playbackFailure = "";
  let lastPositiveVolume = video.volume > 0 ? video.volume : 1;
  let actualAudio = { index: null, language: "" };
  let syncedCues = [], syncEnabled = false, syncManualBaseline = 0;
  let syncState = "off", syncCorrections = [];
  const syncReporter = createSubtitleSyncReporter({ token: root.dataset.progressToken,
    getSnapshot() {
      return { serverInstanceId: expectedServerInstanceId, version: expectedVersion, subtitleUrl,
        enabled: syncEnabled, state: syncState,
        automaticOffset: syncEnabled ? appliedSubtitleOffset(syncCorrections) : 0,
        manualBaseline: syncEnabled ? syncManualBaseline : 0,
        time: Number.isFinite(video.currentTime) ? video.currentTime : 0 };
    } });
  const subtitleSync = createSubtitleSyncController({
    token: root.dataset.progressToken,
    onChange({ state, stage, elapsedMs, enabled, eligible, corrections }) {
      if (enabled && !syncEnabled) syncManualBaseline = subtitleDelay;
      syncEnabled = enabled;
      syncState = state; syncCorrections = corrections;
      updateDelayState();
      syncedCues = enabled ? alignedSubtitleCues(cues, corrections) : cues;
      if (syncButton) {
        syncButton.disabled = !eligible;
        syncButton.textContent = "Auto-sync";
        syncButton.setAttribute("aria-pressed", String(enabled));
      }
      if (syncStatus) {
        const hasReference = corrections.length > 0;
        const labels = {
          off: eligible ? "" : "Requiere subtítulos y audio en inglés",
          waiting: "Esperando diálogo…", working: "Sincronizando este tramo… Puede tardar hasta 3 minutos",
          ready: "Referencia actualizada", insufficient: hasReference
            ? "Sin nueva coincidencia; se mantiene el último ajuste"
            : "Sin coincidencia fiable; esperando otra sección con diálogo",
          busy: "Motor ocupado; reintentando…", unavailable: "Motor no disponible; reintentando…",
          error: "No se pudo sincronizar; reintentando…",
          stale: "La fuente ha cambiado; abre la reproducción actual",
        };
        const stages = { preparing: "Preparando subtítulos", extracting: "Extrayendo audio",
          loading_model: "Cargando motor de voz", queued: "Esperando al motor",
          recognizing: "Reconociendo diálogo", matching: "Comprobando coincidencias" };
        const working = stages[stage] ? `${stages[stage]}… ${Math.floor(elapsedMs / 1000)} s` : labels.working;
        const text = (state === "working" ? working : labels[state] || "") +
          (hasReference && ["working", "waiting", "busy", "unavailable", "error"].includes(state)
            ? " · Último ajuste activo" : "");
        if (syncStatus.textContent !== text) syncStatus.textContent = text;
      }
      renderCaption();
      syncReporter.report();
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
  const controlsObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
    root.style.setProperty("--controls-height", `${controls.offsetHeight}px`);
  }) : null;
  controlsObserver?.observe(controls);

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
    if (root.clientWidth <= 760 && !isFullscreen()) return;
    if (video.paused || video.ended || playbackFailure || video.error || controlsPointerDown || controlsHaveFocus()) {
      return;
    }
    root.classList.add("is-controls-hidden");
    root.dataset.controlsState = "hidden";
  }

  function scheduleControlsHide() {
    clearControlsTimer();
    if (root.clientWidth <= 760 && !isFullscreen()) return;
    if (video.paused || video.ended || playbackFailure || video.error || controlsPointerDown || controlsHaveFocus()) {
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
    root.classList[playbackFailure ? "add" : "remove"]("has-playback-error");
    message.textContent = text;
    message.hidden = !text;
  }

  function marathonButton(action, label, item, disabled = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.marathonAction = action;
    button.dataset.marathonId = item.id;
    button.textContent = label;
    button.disabled = marathonBusy || disabled;
    const actionLabel = {
      "move-up": "Subir",
      "move-down": "Bajar",
      remove: "Quitar",
    }[action];
    button.setAttribute("aria-label", `${actionLabel} ${item.title}`);
    return button;
  }

  function renderMarathon(state) {
    if (!marathonRoot || !marathonList) return;
    if (!state) {
      marathonState = null;
      marathonFingerprint = "";
      marathonRoot.hidden = true;
      cancelMarathonCountdown();
      return;
    }
    const fingerprint = JSON.stringify(state);
    if (fingerprint === marathonFingerprint) {
      marathonState = state;
      return;
    }
    marathonFingerprint = fingerprint;
    const focused = document.activeElement === document.body && marathonFocus
      ? marathonFocus : document.activeElement;
    marathonFocus = null;
    const focusAction = marathonRoot.contains(focused) ? focused.dataset.marathonAction : null;
    const focusId = focused?.dataset?.marathonId;
    const focusIndex = marathonState?.items?.findIndex(item => item.id === focusId) ?? -1;
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
    if (marathonUndo) {
      marathonUndo.hidden = !state.canUndo;
      marathonUndo.disabled = marathonBusy || !state.canUndo;
      marathonUndo.textContent = state.undoTitle ? `Deshacer: ${state.undoTitle}` : "Deshacer última eliminación";
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
    }
    (state.items || []).forEach((item, index) => {
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
    if (focusAction && !marathonBusy) {
      const buttons = [...marathonRoot.querySelectorAll("[data-marathon-action]")].filter(item => !item.disabled && !item.hidden);
      const neighborId = state.items?.[Math.min(Math.max(0, focusIndex), state.items.length - 1)]?.id;
      const target = buttons.find(item => item.dataset.marathonAction === focusAction && item.dataset.marathonId === focusId)
        || buttons.find(item => item.dataset.marathonId === (focusId || neighborId))
        || buttons.find(item => item.dataset.marathonId === neighborId && item.dataset.marathonAction === focusAction)
        || buttons.find(item => item.dataset.marathonId === neighborId)
        || buttons[0];
      target?.focus({ preventScroll: true });
    }
  }

  function setMarathonBusy(busy, text = "") {
    if (busy && marathonRoot?.contains(document.activeElement)) marathonFocus = document.activeElement;
    marathonBusy = busy;
    if (busy) marathonRevision++;
    if (marathonOperation) marathonOperation.textContent = text;
    marathonRoot?.setAttribute("aria-busy", String(busy));
    if (busy) {
      for (const button of marathonRoot?.querySelectorAll("[data-marathon-action]") || []) {
        if (button.dataset.marathonAction !== "cancel-countdown") button.disabled = true;
      }
    }
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
    body.set("version", String(expectedVersion));
    body.set("serverInstanceId", expectedServerInstanceId);
    const controller = new AbortController();
    mutationControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (controller.signal.aborted) throw new Error("La solicitud tardó demasiado. Comprueba la conexión e inténtalo de nuevo.");
    if (!response.ok) {
      const error = new Error(response.status === 409
        ? "La fuente ha cambiado. Recarga la página para actualizar la cola."
        : payload.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
    } finally {
      clearTimeout(timeout);
      mutationControllers.delete(controller);
    }
  }

  function updateDelayState() {
    const delay = playbackSubtitleDelay();
    root.dataset.currentDelay = String(delay);
    if (delayState) {
      const sign = delay > 0 ? "+" : "";
      delayState.textContent =
        `${syncEnabled ? "Ajuste sobre Auto-sync" : "Sincronización"} ${sign}${delay.toFixed(2).replace(".", ",")} s`;
    }
  }

  function playbackSubtitleDelay() {
    return subtitleDelay - (syncEnabled ? syncManualBaseline : 0);
  }

  async function advanceMarathon() {
    if (marathonBusy || !marathonState?.canAdvance) {
      return;
    }
    setMarathonBusy(true, "Preparando el siguiente episodio…");
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
    } catch (error) {
      if (disposed) return;
      setMessage();
      setMarathonBusy(false, error.status === 409 ? error.message : "No se pudo abrir el siguiente episodio. Inténtalo de nuevo.");
      marathonFingerprint = "";
      renderMarathon(marathonState);
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
    setMarathonBusy(true, "Actualizando la cola…");
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
      } else if (action === "undo") {
        result = await postForm("/api/marathon/undo");
      }
      if (disposed) return;
      setMarathonBusy(false, "Cola actualizada.");
      marathonFingerprint = "";
      if (result?.marathon) {
        renderMarathon(result.marathon);
      }
    } catch (error) {
      if (disposed) return;
      setMarathonBusy(false, error.status === 409 ? error.message : "No se pudo actualizar la cola. Comprueba la conexión e inténtalo de nuevo.");
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
        if (localProgress) localProgress.textContent = "Reproducción terminada; posición local borrada.";
      } catch {
        if (localProgress) localProgress.textContent = "El navegador no permite actualizar el progreso local.";
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
      if (localProgress) localProgress.textContent = "Progreso guardado en este navegador.";
    } catch {
      root.dataset.resumeState = "unavailable";
      if (localProgress) localProgress.textContent = "El navegador no permite guardar el progreso local.";
    }
  }

  function renderCaption() {
    const activeCue =
      captionsEnabled && captionsLoaded
        ? cueAtTime(syncEnabled ? syncedCues : cues, video.currentTime, playbackSubtitleDelay())
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
    const currentText = formatClock(video.currentTime);
    const durationText = formatClock(duration);
    const nextClock = `${currentText} / ${durationText}`;
    if (nextClock !== lastClock) {
      lastClock = nextClock;
      seek.setAttribute("aria-valuetext", `${currentText} de ${durationText}`);
      clock.textContent = nextClock;
    }
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
    if (video.volume > 0) lastPositiveVolume = video.volume;
    volume.value = String(video.volume);
    volume.setAttribute("aria-valuetext", `${Math.round(video.volume * 100)} %${video.muted ? ", silenciado" : ""}`);
    muteButton.textContent = video.muted || video.volume === 0 ? "MUDO" : "VOL";
    muteButton.setAttribute(
      "aria-label",
      video.muted || video.volume === 0 ? "Activar sonido" : "Silenciar",
    );
  }

  function toggleMute() {
    if (video.muted || video.volume === 0) {
      if (video.volume === 0) video.volume = lastPositiveVolume;
      video.muted = false;
    } else video.muted = true;
    updateVolume();
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
        if (playbackFailure === "No se pudo reanudar. Pulsa Reproducir otra vez o Reintentar.") {
          playbackFailure = "";
          setMessage();
          if (retryButton) retryButton.hidden = true;
          scheduleControlsHide();
        }
      } catch (error) {
        if (error.name !== "AbortError") {
          playbackFailure = "No se pudo reanudar. Pulsa Reproducir otra vez o Reintentar.";
          setMessage();
          showControls({ schedule: false });
          if (retryButton) retryButton.hidden = false;
        }
      }
    } else {
      audioPlayback?.pause();
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
    if (disposed) return;
    subtitleController?.abort();
    const previousUrl = subtitleUrl;
    subtitleUrl = String(nextUrl ?? "");
    root.dataset.subtitleUrl = subtitleUrl;
    const generation = ++subtitleLoadGeneration;
    if (subtitleRetry) subtitleRetry.hidden = true;
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
    const controller = new AbortController();
    subtitleController = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(subtitleUrl, { cache: "no-store", signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const nextCues = parseWebVtt(await response.text());
      if (controller.signal.aborted) throw new Error("Subtitle request timed out");
      if (disposed || generation !== subtitleLoadGeneration) {
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
      if (disposed || generation !== subtitleLoadGeneration) {
        return;
      }
      captionsLoaded = false;
      captionsButton.disabled = true;
      captionsButton.title = "No se pudieron cargar los subtítulos";
      root.dataset.subtitleState = "error";
      if (subtitleRetry) subtitleRetry.hidden = false;
      if (delayState) {
        delayState.textContent = "No se pudieron cargar los subtítulos. Pulsa Reintentar subtítulos.";
      }
    } finally {
      clearTimeout(timeout);
      if (subtitleController === controller) subtitleController = null;
    }
  }

  async function pollStatus() {
    if (disposed || statusController || marathonBusy) return;
    const revision = marathonRevision;
    const controller = new AbortController();
    statusController = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(statusUrl, { cache: "no-store", signal: controller.signal });
      if (!response.ok) {
        return;
      }
      const status = await response.json();
      if (disposed || controller.signal.aborted || marathonBusy || revision !== marathonRevision) return;
      if (
        shouldReloadPlayer(status, {
          version: expectedVersion,
          serverInstanceId: expectedServerInstanceId,
        })
      ) {
        subtitleSync.destroy();
        syncReporter.destroy();
        location.reload();
        return;
      }
      if (Object.hasOwn(status, "marathon")) {
        renderMarathon(status.marathon);
        if (!status.marathon?.autoplay) {
          cancelMarathonCountdown();
        }
      }
      if (status.subtitleLanguage !== undefined && status.subtitleLanguage !== root.dataset.subtitleLanguage) {
        root.dataset.subtitleLanguage = status.subtitleLanguage;
        updateSyncContext();
      }
      if (subtitleStatus && typeof status.subtitleStatus === "string") {
        subtitleStatus.textContent = status.subtitleStatus;
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
    } finally {
      clearTimeout(timeout);
      if (statusController === controller) statusController = null;
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
    scheduleControlsHide();
  });
  video.addEventListener("pause", () => {
    showControls({ schedule: false });
    cancelAnimationFrame(animationFrame);
    updatePlayButton();
    updateClock();
    renderCaption();
    savePosition(true);
  });
  video.addEventListener("ended", () => {
    showControls({ schedule: false });
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
  video.addEventListener("playing", () => {
    if (!root.dataset.hlsUrl) playbackFailure = "";
    setMessage();
    scheduleControlsHide();
  });
  video.addEventListener("canplay", () => setMessage());
  video.addEventListener("error", () => {
    audioPlayback?.nativeError();
    const reasons = { 2: "Se interrumpió la conexión del vídeo.",
      3: "El navegador no pudo decodificar el vídeo (error 3).",
      4: "El navegador no admite esta fuente de vídeo (error 4)." };
    playbackFailure = `${reasons[video.error?.code] || "No se pudo reproducir esta fuente."} Pulsa Reintentar; si continúa, elige otra en Stremio.`;
    video.pause?.();
    showControls({ schedule: false });
    if (retryButton) retryButton.hidden = false;
    setMessage(playbackFailure);
  });

  seek.addEventListener("input", () => {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = (Number(seek.value) / 1000) * video.duration;
      updateClock();
      renderCaption();
    }
  });

  muteButton.addEventListener("click", toggleMute);
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
      toggleMute();
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
      showControls({ schedule: false });
      setMessage(text);
      if (retryButton) retryButton.hidden = false;
    },
    onRecovered() {
      playbackFailure = "";
      setMessage();
      scheduleControlsHide();
      if (retryButton) retryButton.hidden = true;
    },
  }) : null;
  const retryPlayback = () => { savePosition(true); window.location.reload(); };
  retryButton?.addEventListener("click", retryPlayback);
  const retrySubtitles = () => loadSubtitles();
  subtitleRetry?.addEventListener("click", retrySubtitles);
  pollStatus();
  const statusTimer = setInterval(pollStatus, 1000);
  function stopRequests() {
    disposed = true;
    controlsObserver?.disconnect();
    subtitleLoadGeneration++;
    subtitleController?.abort();
    statusController?.abort();
    for (const controller of mutationControllers) controller.abort();
    clearInterval(statusTimer);
  }
  const saveOnExit = () => { savePosition(true); stopRequests(); subtitleSync.destroy(); syncReporter.destroy(); audioPlayback?.destroy(); };
  window.addEventListener("pagehide", saveOnExit);
  const restoreAfterCache = (event) => { if (event.persisted) window.location.reload(); };
  window.addEventListener("pageshow", restoreAfterCache);

  return {
    destroy() {
      stopRequests();
      subtitleSync.destroy();
      syncReporter.destroy();
      syncButton?.removeEventListener("click", toggleSync);
      video.removeEventListener("seeking", syncSeek);
      audioPlayback?.destroy();
      retryButton?.removeEventListener("click", retryPlayback);
      subtitleRetry?.removeEventListener("click", retrySubtitles);
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
