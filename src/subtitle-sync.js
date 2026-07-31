import {
  adjustSubtitleDelay,
  formatSubtitleDelay,
  normalizeSubtitleDelay,
  SUBTITLE_DELAY_MAX,
  SUBTITLE_DELAY_MIN,
  SUBTITLE_DELAY_STEP,
} from "./subtitle-delay.js";

export function createSubtitleDelayPersistence({
  readDelay,
  requestSave,
  onSaved = () => {},
  onStateChange = () => {},
  debounceMs = 180,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer = 0;
  let dirty = false;
  let inFlight = false;
  let failed = false;
  let destroyed = false;

  async function persist() {
    clearTimer(timer);
    timer = 0;
    if (destroyed || inFlight || !dirty) {
      return;
    }

    const requestedDelay = readDelay();
    dirty = false;
    failed = false;
    inFlight = true;
    onStateChange("saving");
    try {
      const result = await requestSave(requestedDelay, {
        keepalive: false,
      });
      if (!dirty && readDelay() === requestedDelay) {
        onSaved(result);
        onStateChange("saved");
      } else {
        onStateChange("pending");
      }
    } catch (error) {
      dirty = true;
      failed = true;
      onStateChange("error", error);
    } finally {
      inFlight = false;
      if (dirty && !failed && !destroyed) {
        timer = setTimer(persist, 0);
      }
    }
  }

  function schedule() {
    if (destroyed) {
      return;
    }
    dirty = true;
    failed = false;
    clearTimer(timer);
    onStateChange("pending");
    timer = setTimer(persist, debounceMs);
  }

  function retry() {
    if (!destroyed && dirty) {
      failed = false;
      return persist();
    }
  }

  function flushOnExit() {
    clearTimer(timer);
    timer = 0;
    if (!dirty) {
      return;
    }
    dirty = false;
    void requestSave(readDelay(), { keepalive: true }).catch(() => {});
  }

  return {
    destroy() {
      destroyed = true;
      clearTimer(timer);
      timer = 0;
    },
    flushOnExit,
    isPending: () => dirty || inFlight,
    persist,
    retry,
    schedule,
  };
}

export function startSubtitleSync({
  playerRoot,
  initialDelay,
  requestSave,
  onDelayChange,
}) {
  const document = playerRoot.ownerDocument;
  const stateLabel = document.querySelector("[data-subtitle-delay-state]");
  const panel = document.querySelector("[data-subtitle-sync]");
  let delay = normalizeSubtitleDelay(initialDelay);

  if (!panel) {
    return {
      destroy() {},
      flushOnExit() {},
      isPending: () => false,
      setExternalDelay(nextDelay) {
        delay = normalizeSubtitleDelay(nextDelay);
        onDelayChange(delay);
      },
      get delay() {
        return delay;
      },
    };
  }

  const value = panel.querySelector("[data-subtitle-delay-value]");
  const saveStatus = panel.querySelector(
    "[data-subtitle-delay-save-status]",
  );
  const retry = panel.querySelector(
    '[data-subtitle-delay-action="retry"]',
  );
  const buttons = Object.fromEntries(
    ["advance", "delay", "reset"].map((action) => [
      action,
      panel.querySelector(`[data-subtitle-delay-action="${action}"]`),
    ]),
  );

  function renderDelay() {
    playerRoot.dataset.currentDelay = String(delay);
    if (stateLabel) {
      stateLabel.textContent = `Sincronización ${formatSubtitleDelay(delay)}`;
    }
    if (value) {
      value.textContent = formatSubtitleDelay(delay);
    }
    if (buttons.advance) {
      buttons.advance.disabled = delay <= SUBTITLE_DELAY_MIN;
    }
    if (buttons.delay) {
      buttons.delay.disabled = delay >= SUBTITLE_DELAY_MAX;
    }
    if (buttons.reset) {
      buttons.reset.disabled = delay === 0;
    }
  }

  function renderSaveState(state) {
    panel.dataset.saveState = state;
    if (saveStatus) {
      saveStatus.textContent = {
        pending: "Cambio aplicado · pendiente de guardar",
        saving: "Guardando…",
        saved: "Sincronizado",
        error: "No se pudo guardar. El ajuste sigue activo en este dispositivo.",
      }[state];
    }
    if (retry) {
      retry.hidden = state !== "error";
    }
  }

  const persistence = createSubtitleDelayPersistence({
    readDelay: () => delay,
    requestSave,
    onSaved(result) {
      delay = normalizeSubtitleDelay(result.subtitleDelay);
      renderDelay();
      onDelayChange(delay);
    },
    onStateChange: renderSaveState,
  });

  function changeDelay(nextDelay) {
    const normalized = normalizeSubtitleDelay(nextDelay);
    if (normalized === delay) {
      return;
    }
    delay = normalized;
    renderDelay();
    onDelayChange(delay);
    persistence.schedule();
  }

  function handleClick(event) {
    const button = event.target.closest?.("[data-subtitle-delay-action]");
    if (!button || !panel.contains(button)) {
      return;
    }
    const action = button.dataset.subtitleDelayAction;
    if (action === "advance") {
      changeDelay(adjustSubtitleDelay(delay, -SUBTITLE_DELAY_STEP));
    } else if (action === "delay") {
      changeDelay(adjustSubtitleDelay(delay, SUBTITLE_DELAY_STEP));
    } else if (action === "reset") {
      changeDelay(0);
    } else if (action === "retry") {
      persistence.retry();
    }
  }

  panel.addEventListener("click", handleClick);
  renderDelay();
  renderSaveState("saved");

  return {
    destroy() {
      persistence.destroy();
      panel.removeEventListener("click", handleClick);
    },
    flushOnExit: persistence.flushOnExit,
    isPending: persistence.isPending,
    setExternalDelay(nextDelay) {
      if (persistence.isPending()) {
        return;
      }
      const normalized = normalizeSubtitleDelay(nextDelay);
      if (normalized !== delay) {
        delay = normalized;
        renderDelay();
        onDelayChange(delay);
      }
    },
    get delay() {
      return delay;
    },
  };
}
