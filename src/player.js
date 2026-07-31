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
  const subtitleUrl = root.dataset.subtitleUrl;
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
  let animationFrame = 0;
  let lastCaption = "";
  let positionRestored = false;
  let lastSavedPosition = 0;
  let controlsTimer = 0;
  let surfaceTapTimer = 0;
  let feedbackTimer = 0;
  let lastSurfaceTap = null;
  let marathonState = null;
  let marathonFingerprint = "";
  let marathonBusy = false;
  let marathonCountdownTimer = 0;
  let marathonCountdownRemaining = 0;

  video.controls = false;
  root.classList.add("is-enhanced");
  root.dataset.controlsState = "visible";

  function isFullscreen() {
    return document.fullscreenElement === root;
  }

  function controlsHaveFocus() {
    return controls.contains(document.activeElement);
  }

  function clearControlsTimer() {
    clearTimeout(controlsTimer);
    controlsTimer = 0;
  }

  function hideControls() {
    clearControlsTimer();
    if (!isFullscreen() || controlsHaveFocus()) {
      return;
    }
    root.classList.add("is-controls-hidden");
    root.dataset.controlsState = "hidden";
  }

  function scheduleControlsHide() {
    clearControlsTimer();
    if (!isFullscreen() || controlsHaveFocus()) {
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

  function toggleFullscreenControls() {
    if (!isFullscreen()) {
      return;
    }
    if (root.classList.contains("is-controls-hidden")) {
      showControls();
    } else {
      hideControls();
    }
  }

  function setMessage(text = "") {
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
        ? cueAtTime(cues, video.currentTime, subtitleDelay)
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
      await video.play();
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
      lastSurfaceTap?.side === side &&
      now - lastSurfaceTap.time <= DOUBLE_TAP_DELAY;

    clearTimeout(surfaceTapTimer);
    if (isDoubleTap) {
      event.preventDefault();
      lastSurfaceTap = null;
      seekBy(side === "backward" ? -SEEK_STEP : SEEK_STEP, side);
      return;
    }

    lastSurfaceTap = { side, time: now };
    surfaceTapTimer = setTimeout(() => {
      lastSurfaceTap = null;
      if (isFullscreen()) {
        toggleFullscreenControls();
      } else {
        togglePlayback();
      }
    }, DOUBLE_TAP_DELAY);
  }

  async function loadSubtitles() {
    if (!subtitleUrl) {
      captionsEnabled = false;
      captionsButton.disabled = true;
      captionsButton.setAttribute("aria-label", "Subtítulos no disponibles");
      if (delayState) {
        delayState.textContent = "Sin subtítulos";
      }
      return;
    }

    captionsButton.disabled = true;
    captionsButton.title = "Cargando subtítulos";
    try {
      const response = await fetch(subtitleUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      cues = parseWebVtt(await response.text());
      captionsLoaded = cues.length > 0;
      captionsButton.disabled = !captionsLoaded;
      captionsButton.title = captionsLoaded
        ? "Activar o desactivar subtítulos (C)"
        : "Subtítulos no disponibles";
      root.dataset.subtitleState = captionsLoaded ? "ready" : "empty";
      renderCaption();
    } catch {
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
        location.reload();
        return;
      }
      if (status.marathon) {
        renderMarathon(status.marathon);
        if (!status.marathon.autoplay) {
          cancelMarathonCountdown();
        }
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
  root.addEventListener("pointermove", () => {
    if (isFullscreen()) {
      showControls();
    }
  });
  controls.addEventListener("pointerdown", () => {
    showControls({ schedule: false });
  });
  controls.addEventListener("pointerup", scheduleControlsHide);
  controls.addEventListener("focusin", () => {
    showControls({ schedule: false });
  });
  controls.addEventListener("focusout", () => {
    setTimeout(scheduleControlsHide);
  });
  video.addEventListener("play", () => {
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
    updateClock();
    renderCaption();
    savePosition();
  });
  video.addEventListener("seeked", renderCaption);
  video.addEventListener("waiting", () => setMessage("Cargando vídeo…"));
  video.addEventListener("playing", () => setMessage());
  video.addEventListener("canplay", () => setMessage());
  video.addEventListener("error", () =>
    setMessage(
      "Este navegador no puede reproducir esta fuente. Elige otra en Stremio.",
    ),
  );

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
    renderCaption();
  });
  marathonRoot?.addEventListener("click", handleMarathonAction);

  fullscreenButton.addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", () => {
    const fullscreen = isFullscreen();
    fullscreenButton.setAttribute(
      "aria-label",
      fullscreen ? "Salir de pantalla completa" : "Pantalla completa",
    );
    if (fullscreen) {
      showControls();
    } else {
      showControls({ schedule: false });
    }
  });

  root.addEventListener("keydown", (event) => {
    if (["BUTTON", "INPUT", "SELECT"].includes(event.target.tagName)) {
      return;
    }
    if (isFullscreen()) {
      showControls();
    }
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
  pollStatus();
  const statusTimer = setInterval(pollStatus, 1000);
  const saveOnExit = () => savePosition(true);
  window.addEventListener("pagehide", saveOnExit);

  return {
    destroy() {
      clearInterval(statusTimer);
      clearControlsTimer();
      clearTimeout(surfaceTapTimer);
      clearTimeout(feedbackTimer);
      cancelMarathonCountdown();
      cancelAnimationFrame(animationFrame);
      marathonRoot?.removeEventListener(
        "click",
        handleMarathonAction,
      );
      window.removeEventListener("pagehide", saveOnExit);
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
