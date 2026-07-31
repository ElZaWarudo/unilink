export const SUBTITLE_DELAY_MIN = -30;
export const SUBTITLE_DELAY_MAX = 30;
export const SUBTITLE_DELAY_STEP = 0.05;

export function normalizeSubtitleDelay(value) {
  const delay = Number(value);
  if (!Number.isFinite(delay)) {
    return 0;
  }
  const clamped = Math.max(
    SUBTITLE_DELAY_MIN,
    Math.min(SUBTITLE_DELAY_MAX, delay),
  );
  const normalized =
    Math.round(Math.round(clamped / SUBTITLE_DELAY_STEP) * 5) / 100;
  return Object.is(normalized, -0) ? 0 : normalized;
}

export function adjustSubtitleDelay(currentDelay, change) {
  return normalizeSubtitleDelay(
    normalizeSubtitleDelay(currentDelay) + Number(change),
  );
}

export function formatSubtitleDelay(value) {
  const delay = normalizeSubtitleDelay(value);
  const sign = delay > 0 ? "+" : delay < 0 ? "−" : "";
  return `${sign}${Math.abs(delay).toFixed(2).replace(".", ",")} s`;
}
