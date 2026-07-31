import { formatSubtitleDelay } from "./subtitle-delay.js";

export const SUBTITLE_SYNC_STYLES = `
    .subtitle-sync {
      display: grid;
      grid-template-columns: minmax(220px, .8fr) minmax(0, 1.2fr);
      gap: var(--space-5);
      align-items: center;
      margin-top: var(--space-3);
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      background: var(--surface);
      padding: var(--space-4);
    }
    .subtitle-sync-copy h2 { margin-bottom: var(--space-1); font-size: 1rem; }
    .subtitle-sync-copy p {
      margin: 0;
      color: var(--quiet);
      font-size: .78rem;
      line-height: 1.45;
    }
    .subtitle-sync-controls {
      display: grid;
      grid-template-columns: minmax(112px, 1fr) auto minmax(112px, 1fr) auto;
      gap: var(--space-2);
      align-items: center;
    }
    .subtitle-sync-controls button {
      min-height: 48px;
      border-color: var(--line-strong);
      background: var(--base);
      color: var(--text);
      padding: 8px 12px;
      white-space: nowrap;
    }
    .subtitle-sync-controls button:hover { background: var(--surface-raised); }
    .subtitle-sync-controls button:disabled { cursor: not-allowed; opacity: .4; }
    .subtitle-delay-value {
      min-width: 92px;
      color: var(--signal);
      font-family: ui-monospace, "Cascadia Mono", monospace;
      font-size: 1rem;
      font-weight: 800;
      text-align: center;
      white-space: nowrap;
    }
    .subtitle-sync-state {
      grid-column: 2;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-2);
      min-height: 24px;
    }
    .subtitle-sync-status { margin: 0; color: var(--quiet); font-size: .76rem; line-height: 1.3; }
    .subtitle-sync[data-save-state="error"] .subtitle-sync-status { color: var(--danger); }
    .subtitle-sync-retry {
      min-height: 32px;
      border-color: var(--danger);
      background: transparent;
      color: #ffd4d0;
      padding: 5px 10px;
      font-size: .74rem;
    }`;

export const SUBTITLE_SYNC_TABLET_STYLES = `
      .subtitle-sync { grid-template-columns: 1fr; }
      .subtitle-sync-state { grid-column: 1; }`;

export const SUBTITLE_SYNC_MOBILE_STYLES = `
      .subtitle-sync { margin-inline: -16px; border-radius: 0; }
      .subtitle-sync-controls { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
      .subtitle-sync-controls button { min-width: 0; white-space: normal; }
      .subtitle-delay-value { grid-column: 1 / -1; grid-row: 1; }
      .subtitle-sync-controls [data-subtitle-delay-action="advance"] { grid-column: 1; grid-row: 2; }
      .subtitle-sync-controls [data-subtitle-delay-action="delay"] { grid-column: 2; grid-row: 2; }
      .subtitle-sync-controls [data-subtitle-delay-action="reset"] { grid-column: 1 / -1; grid-row: 3; }`;

export function subtitleSyncPanel(delay) {
  return `<section class="subtitle-sync" data-subtitle-sync data-save-state="saved"
    aria-labelledby="subtitleSyncTitle">
    <div class="subtitle-sync-copy">
      <h2 id="subtitleSyncTitle">Sincronización de subtítulos</h2>
      <p>“Antes” adelanta el texto; “Después” lo retrasa. Cada toque mueve 0,05 s.</p>
    </div>
    <div class="subtitle-sync-controls" role="group" aria-label="Ajustar sincronización">
      <button type="button" data-subtitle-delay-action="advance"
        aria-label="Mostrar subtítulos 0,05 segundos antes">Antes −0,05 s</button>
      <output class="subtitle-delay-value" data-subtitle-delay-value
        aria-label="Desfase actual">${formatSubtitleDelay(delay)}</output>
      <button type="button" data-subtitle-delay-action="delay"
        aria-label="Mostrar subtítulos 0,05 segundos después">Después +0,05 s</button>
      <button class="secondary" type="button" data-subtitle-delay-action="reset">Restablecer</button>
    </div>
    <div class="subtitle-sync-state">
      <p class="subtitle-sync-status" data-subtitle-delay-save-status
        role="status" aria-live="polite">Sincronizado</p>
      <button class="subtitle-sync-retry" type="button"
        data-subtitle-delay-action="retry" hidden>Reintentar</button>
    </div>
  </section>`;
}
