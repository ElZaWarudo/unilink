import {
  formatSubtitleDelay,
  SUBTITLE_DELAY_MAX,
  SUBTITLE_DELAY_MIN,
  SUBTITLE_DELAY_STEP,
} from "./subtitle-delay.js";

const SUBTITLE_DELAY_STEP_LABEL = SUBTITLE_DELAY_STEP.toFixed(2).replace(
  ".",
  ",",
);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function streamPresentation(active) {
  if (active.unilinkEpisode) {
    const episode = active.unilinkEpisode;
    const source =
      active.description || active.title || active.name || "";
    return {
      title:
        episode.title ||
        `Temporada ${episode.season} · Episodio ${episode.episode}`,
      details: [
        `T${episode.season} · E${episode.episode}`,
        String(source).replace(/\s+/g, " ").trim(),
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }
  const raw =
    active.description || active.title || active.name || "Reproducción activa";
  const [title, ...details] = String(raw)
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  return {
    title: title || "Reproducción activa",
    details: details.join(" "),
  };
}

function playbackIdentity(active) {
  if (active.unilinkContent?.type && active.unilinkContent?.id) {
    return `${active.unilinkContent.type}:${active.unilinkContent.id}`;
  }
  if (active.infoHash) {
    return `${String(active.infoHash).toLowerCase()}:${active.fileIdx ?? -1}`;
  }
  return active.candidateId || `version:${active.version}`;
}

function layout(
  title,
  content,
  script = "",
  pageClass = "",
  moduleSrc = "",
) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#0b0d0e">
  <title>${escapeHtml(title)} · Unilink</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: "Segoe UI Variable", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      --base: #0b0d0e;
      --surface: #121618;
      --surface-raised: #181d20;
      --text: #f3f5f3;
      --muted: #a2aba7;
      --quiet: #737d79;
      --line: #2b3230;
      --line-strong: #414b47;
      --signal: #6ce5bd;
      --signal-ink: #062a20;
      --danger: #ff8d86;
      --danger-surface: #281515;
      --space-1: 4px;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-5: 24px;
      --space-6: 32px;
      --space-7: 48px;
      --space-8: 64px;
      --radius-sm: 4px;
      --radius-md: 8px;
      --radius-lg: 12px;
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    html { background: var(--base); }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--base);
      color: var(--text);
    }
    a { color: inherit; }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .skip-link {
      position: fixed;
      z-index: 10;
      top: var(--space-3);
      left: var(--space-3);
      transform: translateY(-180%);
      background: var(--signal);
      color: var(--signal-ink);
      padding: 10px 14px;
      border-radius: var(--radius-sm);
      font-weight: 750;
    }
    .skip-link:focus { transform: none; }
    .site-header,
    main {
      width: min(1040px, calc(100% - 48px));
      margin-inline: auto;
    }
    .site-header {
      min-height: 72px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--line);
    }
    .wordmark {
      display: inline-flex;
      align-items: baseline;
      gap: var(--space-3);
      font-family: ui-monospace, "Cascadia Mono", monospace;
      font-size: .8rem;
      font-weight: 800;
      letter-spacing: .12em;
    }
    .wordmark small,
    .network-state {
      color: var(--quiet);
      font-family: ui-monospace, "Cascadia Mono", monospace;
      font-size: .7rem;
      font-weight: 600;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .network-state::before {
      content: "";
      display: inline-block;
      width: 7px;
      height: 7px;
      margin-right: var(--space-2);
      border-radius: 50%;
      background: var(--signal);
      box-shadow: 0 0 0 4px rgb(108 229 189 / .09);
    }
    main { padding: var(--space-7) 0 var(--space-8); }
    .page-intro { max-width: 760px; }
    .eyebrow,
    .section-index {
      margin: 0 0 var(--space-3);
      color: var(--signal);
      font-family: ui-monospace, "Cascadia Mono", monospace;
      font-size: .72rem;
      font-weight: 800;
      letter-spacing: .12em;
      text-transform: uppercase;
    }
    h1, h2, p { margin-top: 0; }
    h1 {
      max-width: 18ch;
      margin-bottom: var(--space-4);
      font-size: clamp(2.25rem, 5vw, 3.75rem);
      font-weight: 720;
      line-height: 1.02;
      letter-spacing: -.045em;
      text-wrap: balance;
    }
    h2 {
      margin-bottom: var(--space-3);
      font-size: clamp(1.25rem, 2.2vw, 1.65rem);
      line-height: 1.15;
      letter-spacing: -.02em;
    }
    p { color: var(--muted); line-height: 1.65; }
    .lede { max-width: 68ch; font-size: 1.05rem; }
    .workbench {
      margin-top: var(--space-7);
      padding: var(--space-6);
      border-top: 2px solid var(--signal);
      border-radius: 0 0 var(--radius-md) var(--radius-md);
      background: var(--surface);
    }
    .field { min-width: 0; }
    label {
      display: block;
      margin-bottom: var(--space-2);
      font-size: .9rem;
      font-weight: 720;
    }
    .field-help {
      display: block;
      margin-top: var(--space-2);
      color: var(--quiet);
      font-size: .82rem;
      line-height: 1.45;
    }
    input, select {
      width: 100%;
      min-height: 48px;
      border: 1px solid var(--line-strong);
      border-radius: var(--radius-md);
      outline: 0;
      background: var(--base);
      color: var(--text);
      padding: 12px 14px;
      font: inherit;
    }
    input:hover, select:hover { border-color: #66736e; }
    input:focus-visible, select:focus-visible {
      border-color: var(--signal);
      box-shadow: 0 0 0 3px rgb(108 229 189 / .18);
      outline: 2px solid var(--signal);
      outline-offset: 3px;
    }
    .fields {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(150px, .34fr);
      gap: var(--space-4);
    }
    .actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--space-3);
      margin-top: var(--space-5);
    }
    button, .button {
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      background: var(--signal);
      color: var(--signal-ink);
      padding: 10px 16px;
      font: inherit;
      font-weight: 750;
      line-height: 1.2;
      text-decoration: none;
      cursor: pointer;
    }
    button:hover, .button:hover { background: #89edcd; }
    button:focus-visible, .button:focus-visible, summary:focus-visible {
      outline: 3px solid rgb(108 229 189 / .4);
      outline-offset: 3px;
    }
    .secondary {
      border-color: var(--line-strong);
      background: transparent;
      color: var(--text);
    }
    .secondary:hover { background: var(--surface-raised); }
    .notice {
      margin: var(--space-5) 0 0;
      padding: var(--space-3) var(--space-4);
      border-left: 3px solid var(--signal);
      background: rgb(108 229 189 / .08);
      color: #ccefe2;
    }
    .error {
      border-color: var(--danger);
      background: var(--danger-surface);
      color: #ffd4d0;
    }
    code, .endpoint {
      color: #d5f7eb;
      font-family: ui-monospace, "Cascadia Mono", monospace;
      font-size: .84em;
      overflow-wrap: anywhere;
    }
    .endpoint-note {
      margin-top: var(--space-5);
      color: var(--quiet);
      font-size: .82rem;
    }
    .stream-summary {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--space-4);
      align-items: end;
      margin-top: var(--space-5);
      padding: var(--space-4) 0;
      border-block: 1px solid var(--line);
    }
    .stream-title {
      margin: 0;
      color: var(--text);
      font-size: 1.02rem;
      font-weight: 650;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .stream-data {
      margin: 0;
      color: var(--muted);
      font-family: ui-monospace, "Cascadia Mono", monospace;
      font-size: .76rem;
      line-height: 1.5;
      text-align: right;
    }
    .activation-layout {
      display: grid;
      grid-template-columns: minmax(0, 1.25fr) minmax(280px, .75fr);
      gap: var(--space-7);
      margin-top: var(--space-7);
    }
    .activation main { padding-top: var(--space-6); }
    .activation .page-intro { max-width: none; }
    .activation .page-intro h1 {
      max-width: none;
      font-size: clamp(2.25rem, 4.2vw, 3.2rem);
    }
    .activation .stream-summary,
    .activation .activation-layout { margin-top: var(--space-6); }
    .handoff {
      padding: var(--space-6);
      border-top: 2px solid var(--signal);
      background: var(--surface);
    }
    .route {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--space-2);
      margin-top: var(--space-5);
    }
    .route input {
      font-family: ui-monospace, "Cascadia Mono", monospace;
      font-size: .8rem;
    }
    .route button { white-space: nowrap; }
    .copy-status {
      min-height: 1.35em;
      margin: var(--space-2) 0 0;
      color: var(--signal);
      font-size: .78rem;
    }
    .settings {
      padding-left: var(--space-6);
      border-left: 1px solid var(--line);
    }
    .settings .fields { grid-template-columns: 1fr; }
    .settings .actions { margin-top: var(--space-4); }
    .sub-count { margin-bottom: var(--space-5); font-size: .9rem; }
    .field-label {
      display: block;
      margin-bottom: var(--space-2);
      font-size: .9rem;
      font-weight: 720;
    }
    .subtitle-sync-current { color: var(--text); font-size: 14px; }
    .subtitle-sync-current output { font-weight: 700; }
    .subtitle-sync-current span { color: var(--muted); font-size: 12px; }
    .delay-stepper {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-2);
      align-items: stretch;
    }
    .delay-stepper button {
      min-width: 0;
      border-color: var(--line-strong);
      background: var(--base);
      color: var(--text);
      padding-inline: 10px;
    }
    .delay-stepper [data-subtitle-delay-change] {
      min-height: 54px;
      flex-direction: column;
      gap: 2px;
      line-height: 1.1;
    }
    .delay-stepper [data-subtitle-delay-change] small {
      color: var(--quiet);
      font-family: ui-monospace, "Cascadia Mono", monospace;
      white-space: nowrap;
    }
    .delay-stepper button:hover { background: var(--surface-raised); }
    .delay-stepper output {
      grid-column: 1 / -1;
      grid-row: 1;
      display: grid;
      place-items: center;
      border: 1px solid var(--line-strong);
      border-radius: var(--radius-md);
      background: var(--surface-raised);
      color: var(--signal);
      padding: 8px 10px;
      font-family: ui-monospace, "Cascadia Mono", monospace;
      font-weight: 800;
      white-space: nowrap;
    }
    .delay-stepper .delay-reset {
      grid-column: 1 / -1;
      min-height: 36px;
      color: var(--quiet);
      font-size: .78rem;
    }
    .completion-note {
      margin-top: var(--space-5);
      color: var(--quiet);
      font-size: .82rem;
    }
    .waiting-state { max-width: 760px; }
    .waiting-line {
      display: inline-flex;
      align-items: center;
      gap: var(--space-3);
      margin-bottom: var(--space-5);
      color: var(--muted);
      font-family: ui-monospace, "Cascadia Mono", monospace;
      font-size: .78rem;
      text-transform: uppercase;
      letter-spacing: .08em;
    }
    .waiting-line::before {
      content: "";
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--signal);
      animation: signal 1.4s ease-in-out infinite;
    }
    @keyframes signal { 50% { opacity: .25; } }
    .relay-steps {
      margin: var(--space-7) 0 0;
      padding: 0;
      list-style: none;
      counter-reset: relay;
      border-top: 1px solid var(--line);
    }
    .relay-steps li {
      counter-increment: relay;
      display: grid;
      grid-template-columns: 44px minmax(0, 1fr);
      gap: var(--space-4);
      padding: var(--space-4) 0;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      line-height: 1.55;
    }
    .relay-steps li::before {
      content: "0" counter(relay);
      color: var(--signal);
      font-family: ui-monospace, "Cascadia Mono", monospace;
      font-size: .75rem;
    }
    .watch .site-header,
    .watch main { width: min(1240px, calc(100% - 48px)); }
    .watch main { padding-top: var(--space-5); }
    .playback-head {
      margin-bottom: var(--space-5);
    }
    .playback-head h1 {
      max-width: 24ch;
      margin-bottom: var(--space-2);
      font-size: clamp(1.8rem, 3.8vw, 3rem);
      overflow-wrap: anywhere;
    }
    .playback-head .stream-data { text-align: left; }
    .playback-status {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2) var(--space-5);
      margin-top: var(--space-4);
      color: var(--muted);
      font-family: ui-monospace, "Cascadia Mono", monospace;
      font-size: .72rem;
      text-transform: uppercase;
      letter-spacing: .05em;
    }
    .playback-status span::before {
      content: "—";
      margin-right: var(--space-2);
      color: var(--signal);
    }
    .playback-status span:empty { display: none; }
    .player {
      position: relative;
      overflow: hidden;
      border-radius: var(--radius-md);
      background: #000;
      touch-action: manipulation;
      user-select: none;
    }
    .player:focus-visible {
      outline: 3px solid rgb(108 229 189 / .55);
      outline-offset: 3px;
    }
    .player-surface { position: relative; }
    .player video {
      display: block;
      width: 100%;
      aspect-ratio: 16 / 9;
      max-height: calc(100vh - 300px);
      min-height: 280px;
      background: #000;
      object-fit: contain;
      cursor: pointer;
    }
    .player-caption {
      position: absolute;
      z-index: 2;
      left: 50%;
      bottom: calc(var(--controls-height, 180px) + 12px);
      width: max-content;
      max-width: min(84%, 920px);
      transform: translateX(-50%);
      border-radius: var(--radius-sm);
      background: rgb(0 0 0 / .86);
      color: white;
      padding: 7px 12px;
      font-size: clamp(1rem, 2.2vw, 1.55rem);
      font-weight: 650;
      line-height: 1.35;
      text-align: center;
      text-wrap: balance;
      white-space: pre-line;
      pointer-events: none;
      margin: 0;
      transition: bottom 180ms ease;
    }
    .player-message {
      position: absolute;
      z-index: 3;
      inset: 50% auto auto 50%;
      width: min(90%, 520px);
      transform: translate(-50%, -50%);
      border-left: 3px solid var(--signal);
      background: rgb(11 13 14 / .92);
      color: var(--text);
      padding: var(--space-3) var(--space-4);
      line-height: 1.5;
      text-align: center;
      pointer-events: none;
    }
    .player.has-playback-error .player-caption { display: none; }
    .player-seek-feedback {
      position: absolute;
      z-index: 3;
      top: 50%;
      left: 25%;
      min-width: 76px;
      margin: 0;
      transform: translate(-50%, -44%) scale(.94);
      border-radius: 999px;
      background: rgb(11 13 14 / .82);
      color: var(--text);
      padding: 12px 16px;
      font-family: ui-monospace, "Cascadia Mono", monospace;
      font-size: .84rem;
      font-weight: 800;
      letter-spacing: .04em;
      text-align: center;
      opacity: 0;
      pointer-events: none;
      transition: opacity 120ms ease, transform 120ms ease;
    }
    .player-seek-feedback[data-side="forward"] { left: 75%; }
    .player-seek-feedback.is-visible {
      transform: translate(-50%, -50%) scale(1);
      opacity: 1;
    }
    .player-controls {
      position: absolute;
      z-index: 4;
      right: 0;
      bottom: 0;
      left: 0;
      display: none;
      padding: 10px 16px;
      background: rgb(11 13 14 / .94);
    }
    .player.is-enhanced .player-controls {
      display: block;
      visibility: visible;
      transform: translateY(0);
      opacity: 1;
      transition:
        opacity 160ms ease,
        transform 160ms ease,
        visibility 0s linear;
    }
    .player.is-enhanced.is-controls-hidden .player-controls {
      visibility: hidden;
      transform: translateY(12px);
      opacity: 0;
      pointer-events: none;
      transition:
        opacity 160ms ease,
        transform 160ms ease,
        visibility 0s linear 160ms;
    }
    .player.is-controls-hidden .player-caption { bottom: 28px; }
    .player-timeline {
      display: grid;
      grid-template-columns: minmax(80px, 1fr) auto;
      align-items: center;
      gap: var(--space-3);
    }
    .player-control-row {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin-top: 2px;
    }
    .player-control-row .control-spacer { flex: 1; }
    .player-sync-row { display: flex; align-items: center; gap: 8px; min-height: 32px; }
    .player-sync-row [role="status"] { min-width: 0; font-size: 11px; line-height: 1.3; color: var(--muted); }
    .player-sync-row [role="status"]:empty { visibility: hidden; }
    .player-controls [data-player-control="subtitle-sync"] { font-size: 11px; padding-inline: 6px; white-space: nowrap; }
    .player-controls button {
      min-width: 44px;
      min-height: 44px;
      border-color: transparent;
      background: transparent;
      color: var(--text);
      padding: 8px 10px;
      font-family: ui-monospace, "Cascadia Mono", monospace;
      font-size: .76rem;
    }
    .player-controls button:hover { background: var(--surface-raised); }
    .player-controls button[aria-pressed="false"] { color: var(--quiet); }
    .player-controls button:disabled {
      color: var(--quiet);
      cursor: wait;
      opacity: .55;
    }
    .player-controls input[type="range"] {
      min-height: 24px;
      border: 0;
      border-radius: 0;
      box-shadow: none;
      background: transparent;
      padding: 0;
      accent-color: var(--signal);
      cursor: pointer;
    }
    .player-seek { width: 100%; }
    .player-volume { width: 92px; }
    .player-audio { display: flex; align-items: center; gap: 8px; min-width: 0; max-width: 45%; }
    .player-audio select { min-width: 0; max-width: 100%; width: auto; padding: 6px; }
    .player-audio label { margin: 0; font-size: 12px; }
    .player-clock {
      color: var(--text);
      font-family: ui-monospace, "Cascadia Mono", monospace;
      font-size: .72rem;
      white-space: nowrap;
    }
    .player:fullscreen {
      width: 100%;
      height: 100%;
      border-radius: 0;
    }
    .player:fullscreen .player-surface { height: 100%; }
    .player:fullscreen video {
      width: 100%;
      height: 100%;
      max-height: none;
    }
    .player.is-controls-hidden,
    .player.is-controls-hidden video {
      cursor: none;
    }
    .marathon-panel {
      margin-top: var(--space-6);
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      background: var(--surface);
      padding: var(--space-5);
    }
    .marathon-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-5);
    }
    .marathon-head h2 { margin-bottom: var(--space-2); }
    .marathon-head p { margin-bottom: 0; }
    .marathon-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: var(--space-2);
    }
    .marathon-actions button {
      min-height: 38px;
      padding: 8px 12px;
      font-size: .8rem;
    }
    .marathon-list {
      display: grid;
      gap: var(--space-2);
      margin: var(--space-5) 0 0;
      padding: 0;
      list-style: none;
      counter-reset: marathon;
    }
    .marathon-item {
      counter-increment: marathon;
      display: grid;
      grid-template-columns: 42px minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--space-3);
      min-height: 70px;
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      background: var(--base);
      padding: var(--space-3);
    }
    .marathon-item::before {
      content: counter(marathon, decimal-leading-zero);
      color: var(--signal);
      font-family: ui-monospace, "Cascadia Mono", monospace;
      font-size: .72rem;
    }
    .marathon-item-title {
      display: block;
      color: var(--text);
      font-size: .92rem;
      line-height: 1.35;
    }
    .marathon-item-meta {
      display: block;
      margin-top: 3px;
      color: var(--quiet);
      font-family: ui-monospace, "Cascadia Mono", monospace;
      font-size: .7rem;
    }
    .marathon-item.is-unavailable .marathon-item-meta {
      color: var(--danger);
    }
    .marathon-item-actions {
      display: flex;
      gap: 4px;
    }
    .marathon-item-actions button {
      min-width: 36px;
      min-height: 36px;
      border-color: var(--line);
      background: transparent;
      color: var(--muted);
      padding: 6px;
      font-size: .72rem;
    }
    .marathon-item-actions button:hover {
      background: var(--surface-raised);
      color: var(--text);
    }
    .marathon-item-actions button:disabled {
      cursor: not-allowed;
      opacity: .35;
    }
    .marathon-empty,
    .marathon-warning {
      margin: var(--space-4) 0 0;
      color: var(--quiet);
      font-size: .84rem;
    }
    .marathon-warning { color: var(--danger); }
    .marathon-countdown {
      margin-top: var(--space-4);
      border-radius: var(--radius-sm);
      background: rgb(108 229 189 / .1);
      padding: var(--space-4);
    }
    .marathon-countdown p {
      margin: 0 0 var(--space-3);
      color: #ccefe2;
    }
    .compatibility {
      margin-top: var(--space-4);
      color: var(--quiet);
      font-size: .84rem;
    }
    .compatibility summary {
      width: fit-content;
      min-height: 32px;
      display: flex;
      align-items: center;
      cursor: pointer;
    }
    .compatibility p { max-width: 72ch; margin: var(--space-2) 0 0; }
    .error-actions { margin-top: var(--space-5); }
    @media (max-width: 760px) {
      .site-header, main, .watch .site-header, .watch main {
        width: min(100% - 32px, 1040px);
      }
      .site-header { min-height: 60px; }
      .wordmark small, .network-state { display: none; }
      main { padding: var(--space-6) 0 var(--space-8); }
      h1 { font-size: 2.25rem; }
      .workbench, .handoff { padding: var(--space-5); }
      .fields, .activation-layout {
        grid-template-columns: 1fr;
      }
      .activation-layout { gap: var(--space-6); margin-top: var(--space-6); }
      .settings { padding: var(--space-5) 0 0; border: 0; border-top: 1px solid var(--line); }
      .stream-summary { grid-template-columns: 1fr; gap: var(--space-2); }
      .stream-data { text-align: left; }
      .route { grid-template-columns: 1fr; }
      .route button { width: 100%; }
      .playback-head { margin-bottom: var(--space-4); }
      .playback-head h1 { font-size: 1.8rem; }
      .player { border-radius: var(--radius-sm); }
      .player video { min-height: 0; max-height: 68vh; }
      .player-caption {
        bottom: calc(var(--controls-height, 220px) + 12px);
        max-width: 90%;
        font-size: 1rem;
      }
      .player-controls { padding: var(--space-2); }
      .player:not(:fullscreen) .player-controls { position: relative; }
      .player:not(:fullscreen).is-controls-hidden .player-controls {
        visibility: visible;
        transform: none;
        opacity: 1;
        pointer-events: auto;
      }
      .player:not(:fullscreen) .player-caption { bottom: 14px; }
      .player-control-row { flex-wrap: wrap; }
      .marathon-item-actions button { min-height: 44px; min-width: 44px; }
      .player-volume { display: none; }
      .player-audio { max-width: 48%; }
      .player-clock { font-size: .66rem; }
      .marathon-head {
        align-items: stretch;
        flex-direction: column;
      }
      .marathon-actions { justify-content: flex-start; }
      .marathon-item {
        grid-template-columns: 32px minmax(0, 1fr);
      }
      .marathon-item-actions {
        grid-column: 2;
        justify-content: flex-start;
      }
    }
    @media (max-width: 430px) {
      .actions { align-items: stretch; flex-direction: column; }
      .actions > * { width: 100%; }
      .workbench, .handoff { margin-inline: -16px; border-radius: 0; }
      .playback-status { gap: var(--space-2) var(--space-4); }
    }
    @media (prefers-reduced-motion: reduce) {
      .waiting-line::before { animation: none; }
      .player-caption,
      .player-seek-feedback,
      .player.is-enhanced .player-controls {
        transition: none;
      }
    }
  </style>
</head>
<body class="${escapeHtml(pageClass)}">
  <a class="skip-link" href="#main-content">Saltar al contenido</a>
  <header class="site-header">
    <span class="wordmark">UNI/LINK <small>local relay</small></span>
    <span class="network-state">Red local</span>
  </header>
  <main id="main-content">${content}</main>
  ${script ? `<script>${script}</script>` : ""}
  ${pageClass === "watch" ? '<script src="/hls.js"></script>' : ""}
  ${moduleSrc ? `<script type="module" src="${escapeHtml(moduleSrc)}"></script>` : ""}
</body>
</html>`;
}

export function configurationPage({
  currentUrl = "",
  stremioToken = "",
  saved = false,
  error = "",
  manifestUrl,
  watchUrl = "/watch",
}) {
  let message = "";
  if (error) {
    message = `<p class="notice error" role="alert">${escapeHtml(error)}</p>`;
  } else if (saved) {
    message =
      '<p class="notice" role="status">Configuración guardada. Ya puedes instalar o actualizar el addon.</p>';
  }
  return layout(
    "Configuración",
    `<div class="page-intro">
       <p class="eyebrow">01 / Fuente de streaming</p>
       <h1>Conecta la fuente.</h1>
       <p class="lede">Pega el manifest que ya utilizas en Torrentio. Unilink lo guarda en este ordenador y añade fuentes marcadas como «Unilink» en Stremio.</p>
     </div>
     ${message}
     <form class="workbench" method="post" action="/configure" data-configuration-form>
       <div class="field">
         <label for="torrentioManifestUrl">Manifest de Torrentio</label>
         <input id="torrentioManifestUrl" name="torrentioManifestUrl" type="url" required
           inputmode="url" autocomplete="url" spellcheck="false"
           aria-describedby="manifestHelp"
           placeholder="https://torrentio.strem.fun/.../manifest.json"
           value="${escapeHtml(currentUrl)}">
         <span class="field-help" id="manifestHelp">Debe ser la URL completa terminada en <code>manifest.json</code>.</span>
       </div>
       <div class="actions">
         <button type="submit">Guardar fuente</button>
         <a class="button secondary" href="${escapeHtml(manifestUrl.replace(/^http/, "stremio"))}">Instalar addon en Stremio</a>
       </div>
       <p data-configuration-status role="status" aria-live="polite"></p>
     </form>
     <section class="workbench" aria-labelledby="nextSteps">
       <p class="section-index">02 / Segunda pantalla</p>
       <h2 id="nextSteps">Continúa en el otro dispositivo</h2>
       <ol class="relay-steps">
         <li>Guarda la fuente e instala el addon en Stremio.</li>
         <li>Abre una película o episodio y elige una fuente marcada como «Unilink».</li>
         <li>Abre esta dirección en un dispositivo de la misma red. Mantén Stremio y Unilink abiertos en el PC.</li>
       </ol>
       <div class="route">
         <label class="sr-only" for="watchUrl">Dirección de la segunda pantalla</label>
         <input id="watchUrl" type="text" readonly value="${escapeHtml(watchUrl)}">
         <button class="secondary" id="copyWatchUrl" type="button">Copiar URL</button>
       </div>
       <p id="copyStatus" class="copy-status" role="status"></p>
       <div class="actions"><a class="button secondary" href="${escapeHtml(watchUrl)}">Abrir reproductor</a></div>
     </section>
     <section class="workbench" data-stremio-settings data-token="${escapeHtml(stremioToken)}">
       <p class="section-index">Opcional</p>
       <h2>Progreso en Stremio</h2>
       <p>Puedes ver contenido sin conectar una cuenta. Conéctala si también quieres guardar el progreso en Stremio.</p>
       <p data-stremio-state role="status">Comprobando conexión…</p>
       <div class="actions">
         <button type="button" data-stremio-connect disabled>Conectar Stremio</button>
         <button type="button" class="secondary" data-stremio-disconnect hidden>Desconectar</button>
         <a data-stremio-link target="_blank" rel="noopener noreferrer" hidden>Continuar en Stremio</a>
       </div>
     </section>
     <section class="workbench" id="speech-setup" data-speech-setup data-token="${escapeHtml(stremioToken)}">
       <p class="section-index">Opcional / Audio y subtítulos en inglés</p>
       <h2>Sincronización por voz</h2>
       <p>Relaciona el diálogo con tus subtítulos. El audio se procesa en este PC.</p>
       <div class="actions">
         <label for="speech-backend">Motor de reconocimiento
           <select id="speech-backend" data-speech-backend disabled>
             <option value="cpu">CPU · faster-whisper</option>
             <option value="cuda">NVIDIA CUDA · faster-whisper</option>
             <option value="vulkan">GPU Vulkan · whisper.cpp</option>
           </select>
         </label>
         <button type="button" class="secondary" data-speech-backend-apply disabled>Usar motor</button>
       </div>
       <p>Vulkan permite usar GPU AMD, Intel y NVIDIA compatibles. CUDA requiere una GPU NVIDIA con CUDA 12 y cuDNN 9 instalados. Si la GPU falla, la sincronización continúa por CPU.</p>
       <p data-speech-backend-status role="status"></p>
       <p>La instalación descarga el motor y el modelo de inglés; necesita Internet, espacio libre y <a href="https://www.python.org/downloads/" target="_blank" rel="noopener noreferrer">Python 3.10 o posterior</a> instalado en el PC. Puede tardar varios minutos.</p>
       <p data-speech-setup-status role="status">Comprobando el motor local…</p>
       <button type="button" class="secondary" data-speech-setup-start disabled>Instalar motor de inglés</button>
     </section>
     <p class="endpoint-note">Endpoint local · <code>${escapeHtml(manifestUrl)}</code></p>`,
    `(() => {
      const configuration = document.querySelector('[data-configuration-form]');
      const configurationStatus = configuration.querySelector('[data-configuration-status]');
      configuration.addEventListener('submit', async event => {
        event.preventDefault();
        const save = configuration.querySelector('[type="submit"]');
        if (save.disabled) return;
        save.disabled = true;
        configurationStatus.textContent = 'Guardando fuente…';
        try {
          const response = await fetch('/configure', { method: 'POST', headers: { accept: 'application/json' },
            body: new URLSearchParams(new FormData(configuration)), signal: AbortSignal.timeout(15000) });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'No se pudo guardar la fuente.');
          configurationStatus.textContent = 'Fuente guardada. Instala o actualiza el addon y elige una fuente Unilink en Stremio.';
        } catch (error) {
          configurationStatus.textContent = error.name === 'TimeoutError' ? 'No se pudo confirmar el guardado. Vuelve a intentarlo.' : error.message;
        } finally { save.disabled = false; }
      });
      document.querySelector('#copyWatchUrl').addEventListener('click', async () => {
        const input = document.querySelector('#watchUrl');
        let copied = false;
        try { await navigator.clipboard.writeText(input.value); copied = true; }
        catch { input.select(); copied = document.execCommand('copy'); }
        document.querySelector('#copyStatus').textContent = copied ? 'Dirección copiada.' : 'Selecciona la dirección y cópiala manualmente.';
      });
      const root = document.querySelector('[data-stremio-settings]');
      const state = root.querySelector('[data-stremio-state]');
      const connect = root.querySelector('[data-stremio-connect]');
      const disconnect = root.querySelector('[data-stremio-disconnect]');
      const link = root.querySelector('[data-stremio-link]');
      let timer;
      let generation = 0;
      async function api(action) {
        const response = await fetch('/api/stremio/' + action, {
          method: action === 'status' ? 'GET' : 'POST',
          headers: { 'x-unilink-token': root.dataset.token },
          signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw new Error('connection');
        return response.json();
      }
      function render(value) {
        const connected = ['connected', 'synced', 'error'].includes(value.state);
        connect.hidden = connected || value.state === 'pending';
        connect.disabled = false;
        disconnect.hidden = !connected && value.state !== 'pending';
        disconnect.textContent = value.state === 'pending' ? 'Cancelar' : 'Desconectar';
        if (value.state !== 'pending') link.hidden = true;
        state.textContent = value.state === 'pending' ? 'Confirma la conexión en Stremio. Esta página se actualizará sola.' :
          value.state === 'expired' ? 'La conexión ha caducado. Pulsa Conectar Stremio para reintentar.' :
          value.state === 'error' ? 'No se pudo guardar el último progreso. Se reintentará al reproducir; si continúa, vuelve a conectar la cuenta.' :
          connected ? 'Cuenta conectada. El progreso se guardará automáticamente.' : 'Cuenta sin conectar.';
      }
      async function poll(expected) {
        try {
          const value = await api('poll');
          if (expected !== generation) return;
          render(value);
          if (value.state === 'pending') timer = setTimeout(() => poll(expected), 3000);
        } catch {
          if (expected !== generation) return;
          state.textContent = 'No se pudo comprobar la conexión. Reintentando…';
          timer = setTimeout(() => poll(expected), 5000);
        }
      }
      connect.addEventListener('click', async () => {
        const expected = ++generation;
        const popup = window.open('about:blank', '_blank');
        if (popup) popup.opener = null;
        connect.disabled = true;
        state.textContent = 'Preparando conexión…';
        try {
          const value = await api('connect');
          if (expected !== generation) { popup?.close(); return; }
          render(value);
          if (value.link) {
            link.href = value.link;
            link.hidden = false;
            if (popup) popup.location.replace(value.link);
            poll(expected);
          } else popup?.close();
        } catch {
          popup?.close();
          connect.disabled = false;
          state.textContent = 'No se pudo conectar con Stremio. Vuelve a intentarlo.';
        }
      });
      disconnect.addEventListener('click', async () => {
        generation++;
        clearTimeout(timer);
        disconnect.disabled = true;
        try { render(await api('disconnect')); }
        catch { state.textContent = 'No se pudo desconectar. Vuelve a intentarlo.'; }
        finally { disconnect.disabled = false; }
      });
      api('status').then(render).catch(() => {
        connect.disabled = false;
        state.textContent = 'No se pudo comprobar la conexión. Puedes reintentar.';
      });
      window.addEventListener('pagehide', () => { generation++; clearTimeout(timer); });
      const speech = document.querySelector('[data-speech-setup]');
      const speechState = speech.querySelector('[data-speech-setup-status]');
      const speechStart = speech.querySelector('[data-speech-setup-start]');
      const speechBackend = speech.querySelector('[data-speech-backend]');
      const speechApply = speech.querySelector('[data-speech-backend-apply]');
      const speechBackendState = speech.querySelector('[data-speech-backend-status]');
      const backendLabels = { cpu: 'CPU · faster-whisper', cuda: 'NVIDIA CUDA · faster-whisper', vulkan: 'GPU Vulkan · whisper.cpp' };
      let savedBackend = null;
      let speechBusy = false;
      let speechTimer;
      let speechGeneration = 0;
      const speechController = new AbortController();
      async function speechRequest(method = 'GET') {
        const response = await fetch('/api/speech-setup', { method,
          headers: { 'x-unilink-token': speech.dataset.token },
          signal: AbortSignal.any([speechController.signal, AbortSignal.timeout(15000)]) });
        if (!response.ok) throw new Error('setup');
        return response.json();
      }
      function renderSpeech(value) {
        const selected = value.requestedBackend ?? value.backend ?? 'cpu';
        if (savedBackend === null || speechBackend.value === savedBackend) speechBackend.value = selected;
        savedBackend = selected;
        speechBusy = Boolean(value.busy);
        speechBackend.disabled = speechBusy;
        speechApply.disabled = speechBusy || speechBackend.value === savedBackend;
        const actual = value.runtime?.backend;
        let runtimeText = 'El motor en uso aparecerá al sincronizar.';
        if (actual) {
          runtimeText = (value.runtime.fallbackReason ? 'GPU no disponible; usando ' : 'En uso: ') + backendLabels[actual];
          if (value.runtime.device) runtimeText += ' (' + value.runtime.device + ')';
          runtimeText += '.';
        }
        speechBackendState.textContent = 'Seleccionado: ' + backendLabels[selected] + '. ' + runtimeText;
        speechState.textContent = value.message;
        speech.setAttribute('aria-busy', String(value.busy));
        speechStart.disabled = value.busy || value.state === 'ready';
        const labels = { ready: 'Motor disponible', error: 'Reintentar instalación' };
        speechStart.textContent = value.busy ? 'Instalación en curso…' : labels[value.state] ?? 'Instalar motor de inglés';
      }
      async function pollSpeech(expected) {
        try {
          const value = await speechRequest();
          if (speechController.signal.aborted || expected !== speechGeneration) return;
          renderSpeech(value);
          speechTimer = setTimeout(() => pollSpeech(expected), value.busy ? 2000 : 5000);
        } catch {
          if (speechController.signal.aborted || expected !== speechGeneration) return;
          speechState.textContent = 'No se pudo comprobar la instalación. Reintentando…';
          speechTimer = setTimeout(() => pollSpeech(expected), 5000);
        }
      }
      speechBackend.addEventListener('change', () => {
        speechApply.disabled = speechBusy || speechBackend.value === savedBackend;
      });
      speechApply.addEventListener('click', async () => {
        const expected = ++speechGeneration;
        clearTimeout(speechTimer);
        speechBackend.disabled = speechApply.disabled = speechStart.disabled = true;
        speechBackendState.textContent = 'Cambiando motor…';
        try {
          const response = await fetch('/api/speech-backend', { method: 'POST',
            headers: { 'x-unilink-token': speech.dataset.token, 'content-type': 'application/json' },
            body: JSON.stringify({ backend: speechBackend.value }),
            signal: AbortSignal.any([speechController.signal, AbortSignal.timeout(30000)]) });
          if (!response.ok) throw new Error('backend');
          const value = await response.json();
          if (speechController.signal.aborted || expected !== speechGeneration) return;
          savedBackend = null;
          renderSpeech(value);
          speechTimer = setTimeout(() => pollSpeech(expected), 5000);
        } catch {
          if (speechController.signal.aborted || expected !== speechGeneration) return;
          speechBackendState.textContent = 'No se pudo confirmar el cambio. Comprobando el motor…';
          pollSpeech(expected);
        }
      });
      speechStart.addEventListener('click', async () => {
        const expected = ++speechGeneration;
        clearTimeout(speechTimer);
        speechStart.disabled = true;
        speechBackend.disabled = speechApply.disabled = true;
        speechState.textContent = 'Iniciando instalación…';
        try {
          const value = await speechRequest('POST');
          if (speechController.signal.aborted || expected !== speechGeneration) return;
          renderSpeech(value);
          speechTimer = setTimeout(() => pollSpeech(expected), value.busy ? 2000 : 5000);
        } catch {
          if (speechController.signal.aborted || expected !== speechGeneration) return;
          speechState.textContent = 'Comprobando si la instalación comenzó…';
          pollSpeech(expected);
        }
      });
      pollSpeech(speechGeneration);
      window.addEventListener('pagehide', () => { clearTimeout(speechTimer); speechController.abort(); });
      window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
    })();`,
    "configure",
  );
}

export function activationPage({
  watchUrl,
  active,
  serverInstanceId = "",
  preparing = false,
  subtitleWarning = "",
  settingsSaved = false,
}) {
  const presentation = streamPresentation(active);
  const subtitleCount = active.subtitles?.length ?? 0;
  const subtitleMessage =
    subtitleCount === 1
      ? "1 pista automática disponible"
      : `${subtitleCount} pistas automáticas disponibles`;
  const preferredLanguage =
    active.playbackSettings?.subtitleLanguage ?? "";
  const preferredSubtitleId =
    active.playbackSettings?.subtitleId ?? "";
  const languages = [
    ...new Map(
      (active.subtitles ?? []).map((subtitle) => [
        subtitle.language,
        subtitle.label,
      ]),
    ),
  ];
  const languageOptions = languages
    .map(
      ([language, languageLabel]) =>
        `<option value="${escapeHtml(language)}"${language === preferredLanguage ? " selected" : ""}>${escapeHtml(languageLabel)}</option>`,
    )
    .join("");
  const sourceNumbers = new Map();
  const sourceOptions = (active.subtitles ?? [])
    .map((subtitle) => {
      const sourceNumber =
        (sourceNumbers.get(subtitle.language) ?? 0) + 1;
      sourceNumbers.set(subtitle.language, sourceNumber);
      return `<option value="${escapeHtml(subtitle.id)}"
        data-language="${escapeHtml(subtitle.language)}"
        ${subtitle.id === preferredSubtitleId ? "selected" : ""}>
        Fuente ${sourceNumber} · ${escapeHtml(subtitle.label)}
      </option>`;
    })
    .join("");
  const settingsPanel = subtitleCount
    ? `<form method="post" action="/settings" data-subtitle-settings>
         <input type="hidden" name="serverInstanceId" value="${escapeHtml(serverInstanceId)}">
         <input type="hidden" name="version" value="${escapeHtml(active.version)}">
         <p class="subtitle-sync-current">Sincronización actual: <output data-subtitle-sync-current aria-live="polite">Esperando al reproductor…</output><br>
           <span data-subtitle-sync-state>Se actualizará mientras el reproductor esté abierto.</span></p>
         <div class="fields">
           <div class="field">
             <label for="subtitleLanguage">Idioma preferido</label>
             <select id="subtitleLanguage" name="subtitleLanguage">${languageOptions}</select>
           </div>
           <div class="field">
             <label for="subtitleSource">Fuente de subtítulos</label>
             <select id="subtitleSource" name="subtitleId" aria-describedby="sourceHelp">${sourceOptions}</select>
             <span class="field-help" id="sourceHelp">Alternativas disponibles para el idioma seleccionado.</span>
           </div>
           <div class="field">
             <span class="field-label" id="subtitleDelayLabel">Sincronización</span>
             <input id="subtitleDelay" name="subtitleDelay" type="hidden"
               value="${escapeHtml(active.playbackSettings?.subtitleDelay ?? 0)}">
             <div class="delay-stepper" data-subtitle-delay-stepper
               role="group" aria-labelledby="subtitleDelayLabel" aria-describedby="delayHelp">
               <button type="button" data-subtitle-delay-change="-${SUBTITLE_DELAY_STEP}"
                 aria-label="Mostrar los subtítulos ${SUBTITLE_DELAY_STEP_LABEL} segundos antes"><span>Antes</span><small>−${SUBTITLE_DELAY_STEP_LABEL} s</small></button>
               <output data-subtitle-delay-output
                 aria-label="Desfase seleccionado" aria-live="polite">${formatSubtitleDelay(active.playbackSettings?.subtitleDelay ?? 0)}</output>
               <button type="button" data-subtitle-delay-change="${SUBTITLE_DELAY_STEP}"
                 aria-label="Mostrar los subtítulos ${SUBTITLE_DELAY_STEP_LABEL} segundos después"><span>Después</span><small>+${SUBTITLE_DELAY_STEP_LABEL} s</small></button>
               <button class="delay-reset" type="button" data-subtitle-delay-reset>Restablecer a 0,00 s</button>
             </div>
             <span class="field-help" id="delayHelp">“Antes” adelanta el texto; “Después” lo retrasa.</span>
           </div>
         </div>
         <div class="actions"><button type="submit">Aplicar subtítulos</button></div>
         <p class="copy-status" data-subtitle-settings-status role="status" aria-live="polite"></p>
       </form>`
    : "";
  const copyScript = `const copyButton=document.querySelector("#copyWatchUrl");
     const copyInput=document.querySelector("#watchUrl");
     const copyStatus=document.querySelector("#copyStatus");
     const languageSelect=document.querySelector("#subtitleLanguage");
     const sourceSelect=document.querySelector("#subtitleSource");
     const delayInput=document.querySelector("#subtitleDelay");
     const delayStepper=document.querySelector("[data-subtitle-delay-stepper]");
     const delayOutput=document.querySelector("[data-subtitle-delay-output]");
     const settingsForm=document.querySelector("[data-subtitle-settings]");
     const settingsStatus=document.querySelector("[data-subtitle-settings-status]");
     const delayLabel=document.querySelector("#subtitleDelayLabel");
     const currentSync=document.querySelector("[data-subtitle-sync-current]");
     const syncState=document.querySelector("[data-subtitle-sync-state]");
     let editorBaseline=0, settingsDirty=false, settingsStopped=false, editRevision=0, settingsGeneration=0;
     let settingsTimer;
     let settingsController=new AbortController();
     const formatDelay=value=>{
       const rounded=Number(Number(value).toFixed(2));
       return (rounded>0?"+":rounded<0?"−":"")+Math.abs(rounded).toFixed(2).replace(".",",")+" s";
     };
     const markDirty=()=>{settingsDirty=true;editRevision++;};
     languageSelect?.addEventListener("change",markDirty);
     sourceSelect?.addEventListener("change",markDirty);
     const sourceByLanguage=new Map();
     const syncSubtitleSources=()=>{
       if(!languageSelect||!sourceSelect)return;
       const sources=[...sourceSelect.options];
       const currentSource=sourceSelect.selectedOptions[0];
       if(currentSource?.dataset.language){
         sourceByLanguage.set(currentSource.dataset.language,currentSource.value);
       }
       let firstMatch=null;
       for(const option of sources){
         const matches=option.dataset.language===languageSelect.value;
         option.hidden=!matches;
         option.disabled=!matches;
         if(matches&&!firstMatch)firstMatch=option;
       }
       const remembered=sourceByLanguage.get(languageSelect.value);
       const nextSource=sources.find(option=>
         !option.disabled&&option.value===remembered
       )??firstMatch;
       if(nextSource)nextSource.selected=true;
     };
     languageSelect?.addEventListener("change",syncSubtitleSources);
     syncSubtitleSources();
     const normalizeDelay=value=>{
       const number=Number(value);
       if(!Number.isFinite(number))return 0;
       const normalized=Math.round(Math.max(${SUBTITLE_DELAY_MIN},Math.min(${SUBTITLE_DELAY_MAX},number))/${SUBTITLE_DELAY_STEP})*${SUBTITLE_DELAY_STEP};
       return Object.is(normalized,-0)?0:Number(normalized.toFixed(2));
     };
     const renderDelay=value=>{
       if(!delayInput||!delayOutput)return;
       const delay=normalizeDelay(value);
       delayInput.value=String(delay);
       delayOutput.textContent=formatDelay(delay-editorBaseline);
     };
     const stopForStale=()=>{
       settingsStopped=true;
       clearTimeout(settingsTimer);
       settingsStatus.textContent="La fuente ha cambiado. Abre la emisión actual antes de aplicar ajustes.";
       currentSync.textContent="Emisión anterior";
       syncState.textContent="Abre la emisión actual para ver su sincronización.";
     };
     const reconcileSettings=status=>{
       if(!status.active||status.serverInstanceId!==${JSON.stringify(serverInstanceId)}||status.version!==${Number(active.version)}){
         stopForStale();return;
       }
       const live=status.subtitleSync;
       const valid=live&&Number.isFinite(live.effectiveDelay)&&Number.isFinite(live.manualBaseline);
       currentSync.textContent=valid?formatDelay(live.effectiveDelay):"Esperando al reproductor…";
       syncState.textContent=!valid?"Sin información reciente del reproductor.":live.enabled?
         (live.state==="ready"?"Auto-sync activo":"Auto-sync activo · comprobando el diálogo"):
         "Sincronización manual";
       if(settingsDirty)return;
       const editorAuto=Boolean(valid&&live.enabled);
       editorBaseline=editorAuto?live.manualBaseline:0;
       delayLabel.textContent=editorAuto?"Ajuste adicional":"Sincronización";
       delayStepper.querySelector("[data-subtitle-delay-reset]").textContent=editorAuto?"Restablecer ajuste a 0,00 s":"Restablecer a 0,00 s";
       if(typeof status.subtitleLanguage==="string")languageSelect.value=status.subtitleLanguage;
       if(typeof status.subtitleId==="string")sourceSelect.value=status.subtitleId;
       syncSubtitleSources();
       renderDelay(status.subtitleDelay);
     };
     const pollSettings=async()=>{
       if(settingsStopped)return;
       const generation=settingsGeneration;
       const controller=settingsController;
       try{
         const response=await fetch("/api/status",{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});
         if(!response.ok)throw new Error("status");
         const status=await response.json();
         if(!settingsStopped&&!controller.signal.aborted&&generation===settingsGeneration)reconcileSettings(status);
       }catch{
         if(settingsStopped||controller.signal.aborted)return;
         currentSync.textContent="Sin conexión";
         syncState.textContent="Reintentando obtener la sincronización…";
       }
       if(!settingsStopped&&!controller.signal.aborted)settingsTimer=setTimeout(pollSettings,2000);
     };
     delayStepper?.addEventListener("click",event=>{
       const change=event.target.closest?.("[data-subtitle-delay-change]");
       const reset=event.target.closest?.("[data-subtitle-delay-reset]");
       if(change||reset)markDirty();
       if(change)renderDelay(Number(delayInput.value)+Number(change.dataset.subtitleDelayChange));
       if(reset)renderDelay(editorBaseline);
     });
     renderDelay(delayInput?.value);
     settingsForm?.addEventListener("submit",async event=>{
       event.preventDefault();
       if(settingsStopped)return;
       const submitButton=settingsForm.querySelector('[type="submit"]');
       const submittedRevision=editRevision;
       settingsGeneration++;
       submitButton.disabled=true;
       settingsStatus.textContent="Aplicando…";
       try{
         const response=await fetch(settingsForm.action,{
           method:"POST",
           headers:{accept:"application/json"},
           body:new URLSearchParams(new FormData(settingsForm))
         });
         if(response.status===409){
           stopForStale();
           return;
         }
         if(!response.ok)throw new Error("HTTP "+response.status);
         const status=await response.json();
         if(settingsStopped)return;
         settingsGeneration++;
         settingsDirty=editRevision!==submittedRevision;
         reconcileSettings(status);
         if(settingsStopped)return;
         settingsStatus.textContent="Subtítulos actualizados en el reproductor activo.";
       }catch{
         settingsStatus.textContent="No se pudieron actualizar los subtítulos.";
       }finally{
         submitButton.disabled=false;
       }
     });
     if(settingsForm)pollSettings();
     window.addEventListener("pagehide",()=>{settingsStopped=true;clearTimeout(settingsTimer);settingsController.abort();});
     window.addEventListener("pageshow",event=>{
       if(event.persisted&&settingsForm){settingsStopped=false;settingsController=new AbortController();pollSettings();}
     });
     copyButton?.addEventListener("click",async()=>{
       let copied=false;
       try{
         await navigator.clipboard.writeText(copyInput.value);
         copied=true;
       }catch{
         copyInput.select();
         copied=document.execCommand("copy");
       }
       copyStatus.textContent=copied?"Dirección copiada.":"No se pudo copiar; selecciona la dirección manualmente.";
     });`;
  return layout(
    "Listo para servir",
    `<div class="page-intro">
       <p class="eyebrow">Emisión preparada</p>
       <h1>Lista para la segunda pantalla.</h1>
     </div>
     <div class="stream-summary">
       <p class="stream-title">${escapeHtml(presentation.title)}</p>
       ${presentation.details ? `<p class="stream-data">${escapeHtml(presentation.details)}</p>` : ""}
     </div>
     ${preparing ? '<p class="notice" role="status" data-preparation-state>Preparando subtítulos y siguientes episodios… Ya puedes abrir el reproductor.</p>' : ""}
     ${subtitleWarning ? `<p class="notice error">${escapeHtml(subtitleWarning)}</p>` : ""}
     <p><a href="/session">Ver la emisión actual</a> · <a href="/configure">Configuración</a></p>
     ${settingsSaved ? '<p class="notice" role="status">Subtítulos actualizados en el reproductor activo.</p>' : ""}
     <section class="activation-layout" aria-label="Control de emisión">
       <div class="handoff">
         <p class="section-index">01 / Destino</p>
         <h2>Abre esta dirección en el otro dispositivo</h2>
         <p>La URL permanece fija aunque cambies de película.</p>
         <div class="route">
           <label class="sr-only" for="watchUrl">Dirección de la segunda pantalla</label>
           <input id="watchUrl" type="text" readonly value="${escapeHtml(watchUrl)}">
           <button class="secondary" id="copyWatchUrl" type="button">Copiar URL</button>
         </div>
         <p class="copy-status" id="copyStatus" role="status" aria-live="polite"></p>
         <div class="actions">
           <a class="button" href="${escapeHtml(watchUrl)}">Abrir reproductor</a>
         </div>
       </div>
       <aside class="settings" aria-labelledby="subtitleSettings">
         <p class="section-index">02 / Subtítulos</p>
         <h2 id="subtitleSettings">Idioma, fuente y sincronización</h2>
         <p class="sub-count">${escapeHtml(subtitleMessage)}</p>
         ${settingsPanel || "<p>No se encontraron pistas para esta fuente.</p>"}
       </aside>
     </section>
     <p class="completion-note">El torrent arranca cuando la segunda pantalla solicita el vídeo. Esta pestaña puede cerrarse después.</p>`,
    copyScript + (preparing ? `
      (() => {
        let stopped = false;
        let timer;
        const controller = new AbortController();
        async function pollPreparation() {
          try {
            const response = await fetch('/api/status', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
            if (!response.ok) throw new Error('status');
            const status = await response.json();
            if (stopped) return;
            if (status.serverInstanceId !== ${JSON.stringify(serverInstanceId)} || status.version !== ${Number(active.version)}) {
              document.querySelector('[data-preparation-state]').textContent = 'La fuente ha cambiado. Abre la emisión actual para continuar.';
              return;
            }
            if (!status.preparing) {
              if (typeof settingsDirty !== 'undefined' && settingsDirty) {
                document.querySelector('[data-preparation-state]').textContent = 'Preparación completa. Tus ajustes pendientes se conservan.';
              } else location.replace('/session');
              return;
            }
          } catch {
            if (stopped) return;
            document.querySelector('[data-preparation-state]').textContent = 'No se pudo comprobar la preparación. Reintentando…';
          }
          timer = setTimeout(pollPreparation, 2000);
        }
        window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); controller.abort(); });
        window.addEventListener('pageshow', event => { if (event.persisted) location.replace('/session'); });
        pollPreparation();
      })();` : ""),
    "activation",
  );
}

function marathonPanel(marathon) {
  const visible = Boolean(marathon?.active);
  marathon ??= {};
  const items = marathon.items ?? [];
  const queue = items
    .map((item, index) => {
      const availability = item.prepared
        ? `${item.sourceCount} ${item.sourceCount === 1 ? "fuente preparada" : "fuentes preparadas"}`
        : item.error || "Fuente no disponible";
      return `<li class="marathon-item${item.prepared ? "" : " is-unavailable"}"
          data-marathon-item="${escapeHtml(item.id)}">
        <div>
          <strong class="marathon-item-title">${escapeHtml(item.title)}</strong>
          <span class="marathon-item-meta">T${escapeHtml(item.season)} · E${escapeHtml(item.episode)} · ${escapeHtml(availability)}</span>
        </div>
        <div class="marathon-item-actions" aria-label="Ordenar ${escapeHtml(item.title)}">
          <button type="button" data-marathon-action="move-up"
            data-marathon-id="${escapeHtml(item.id)}"
            aria-label="Subir ${escapeHtml(item.title)}"
            ${index === 0 ? "disabled" : ""}>↑</button>
          <button type="button" data-marathon-action="move-down"
            data-marathon-id="${escapeHtml(item.id)}"
            aria-label="Bajar ${escapeHtml(item.title)}"
            ${index === items.length - 1 ? "disabled" : ""}>↓</button>
          <button type="button" data-marathon-action="remove"
            data-marathon-id="${escapeHtml(item.id)}"
            aria-label="Quitar ${escapeHtml(item.title)}">Quitar</button>
        </div>
      </li>`;
    })
    .join("");
  const warning = marathon.warning
    ? `<p class="marathon-warning" data-marathon-warning role="status">${escapeHtml(marathon.warning)}</p>`
    : '<p class="marathon-warning" data-marathon-warning role="status" hidden></p>';
  const autoplayLabel = marathon.autoplay
    ? "Parar después de este episodio"
    : "Activar reproducción automática";
  return `<section class="marathon-panel" data-marathon aria-labelledby="marathonTitle" ${visible ? "" : "hidden"}>
    <div class="marathon-head">
      <div>
        <p class="section-index">Maratón de serie</p>
        <h2 id="marathonTitle">Siguientes episodios</h2>
        <p>La cola conserva tu preferencia de fuente y puede ordenarse desde esta pantalla.</p>
      </div>
      <div class="marathon-actions">
        <button class="secondary" type="button"
          data-marathon-action="toggle-autoplay"
          aria-pressed="${escapeHtml(marathon.autoplay)}">${autoplayLabel}</button>
        <button type="button" data-marathon-action="advance"
          ${marathon.canAdvance ? "" : "disabled"}>Reproducir siguiente</button>
      </div>
    </div>
    ${warning}
    <p data-marathon-operation role="status" aria-live="polite"></p>
    <button class="secondary" type="button" data-marathon-action="undo" ${marathon.canUndo ? "" : "hidden"}>Deshacer última eliminación</button>
    <ol class="marathon-list" data-marathon-list>${queue}</ol>
    <div class="marathon-countdown" data-marathon-countdown role="status"
      aria-live="assertive" hidden>
      <p data-marathon-countdown-text></p>
      <button class="secondary" type="button"
        data-marathon-action="cancel-countdown">Cancelar cuenta atrás</button>
    </div>
  </section>`;
}

export function subtitleSelection(active) {
  const subtitles = active?.subtitles ?? [];
  const preferredLanguage =
    active?.playbackSettings?.subtitleLanguage ?? "es";
  const preferredSubtitleId =
    active?.playbackSettings?.subtitleId ?? "";
  const preferredSubtitle = subtitles.findIndex(
    (subtitle) =>
      subtitle.language === preferredLanguage &&
      subtitle.id === preferredSubtitleId,
  );
  const languageFallback = subtitles.findIndex(
    (subtitle) => subtitle.language === preferredLanguage,
  );
  const index =
    preferredSubtitle >= 0
      ? preferredSubtitle
      : languageFallback >= 0
        ? languageFallback
        : 0;
  const subtitle = subtitles[index];
  const sourceNumber = subtitle ? subtitles.slice(0, index + 1).filter(track => track.language === subtitle.language).length : 0;
  return {
    index,
    subtitle,
    status: subtitle
      ? `Subtítulos: ${subtitle.label} · fuente ${sourceNumber}`
      : active?.preparing ? "Buscando subtítulos…" : "Sin subtítulos",
    url: subtitle
      ? `/subtitle/${index}.vtt?version=${active.version}&delay=0`
      : "",
  };
}

export function watchPage({
  active,
  serverInstanceId = "",
  progressToken = "",
  marathon = null,
}) {
  if (!active) {
    return layout(
      "Esperando contenido",
      `<section class="waiting-state" role="status" aria-live="polite">
         <p class="waiting-line">Escuchando la red local</p>
         <h1>Esperando una película.</h1>
         <p class="lede">Esta pantalla se conectará automáticamente cuando prepares una fuente desde el ordenador.</p>
         <ol class="relay-steps">
           <li>Abre una película o episodio en Stremio.</li>
           <li>Elige una fuente marcada como «Unilink».</li>
           <li>La reproducción aparecerá aquí sin cambiar de dirección.</li>
         </ol>
         <p data-waiting-status></p>
       </section>`,
      `(() => {
        let stopped = false;
        let timer;
        const controller = new AbortController();
        async function poll() {
          try {
            const response = await fetch('/api/status', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
            if (!response.ok) throw new Error('status');
            const status = await response.json();
            if (stopped) return;
            if (status.active) { location.reload(); return; }
            document.querySelector('[data-waiting-status]').textContent = '';
          } catch {
            if (stopped) return;
            document.querySelector('[data-waiting-status]').textContent = 'No se puede conectar con el PC. Comprueba que Unilink siga abierto; reintentando…';
          }
          timer = setTimeout(poll, 3000);
        }
        window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); controller.abort(); });
        window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
        poll();
      })();`,
      "watch waiting",
    );
  }

  const presentation = streamPresentation(active);
  const subtitles = active.subtitles ?? [];
  const {
    subtitle: selectedSubtitle,
    url: subtitleUrl,
    status: subtitleStatus,
  } = subtitleSelection(active);
  const subtitleDelay = active.playbackSettings?.subtitleDelay ?? 0;
  const resumeKey = playbackIdentity(active);
  return layout(
    presentation.title,
    `<div class="playback-head">
       <div>
         <p class="eyebrow">Reproducción activa</p>
         <h1>${escapeHtml(presentation.title)}</h1>
         ${presentation.details ? `<p class="stream-data">${escapeHtml(presentation.details)}</p>` : ""}
       </div>
       <div class="playback-status" aria-label="Estado de la reproducción">
         <span>Directo desde el host</span>
         <span data-subtitle-status role="status">${escapeHtml(subtitleStatus)}</span>
         <span data-subtitle-delay-state>Sincronización ${formatSubtitleDelay(subtitleDelay)}</span>
         <span data-local-progress role="status">El progreso se guardará en este navegador.</span>
         <span data-stremio-progress role="status"></span>
       </div>
     </div>
     <div class="player"
       data-unilink-player
       data-version="${escapeHtml(active.version)}"
       data-server-instance-id="${escapeHtml(serverInstanceId)}"
       data-status-url="/api/status"
       data-hls-url="/hls/${escapeHtml(serverInstanceId)}/${escapeHtml(active.version)}/master.m3u8"
       data-subtitle-url="${escapeHtml(subtitleUrl)}"
       data-subtitle-language="${escapeHtml(selectedSubtitle?.language || "")}"
       data-subtitle-delay="${escapeHtml(subtitleDelay)}"
       data-resume-key="${escapeHtml(resumeKey)}"
       data-progress-token="${escapeHtml(progressToken)}"
       tabindex="0"
       aria-label="Reproductor de ${escapeHtml(presentation.title)}">
       <div class="player-surface">
       <video controls playsinline preload="metadata"
         aria-label="Vídeo de ${escapeHtml(presentation.title)}"></video>
       <p class="player-caption" data-player-part="caption" aria-hidden="true" hidden></p>
       <p class="player-message" data-player-part="message" role="status" aria-live="polite" hidden></p>
       <p class="player-seek-feedback" data-player-part="seek-feedback"
         role="status" aria-live="polite" aria-atomic="true"></p>
       </div>
       <div class="player-controls" aria-label="Controles de reproducción">
         <div class="player-sync-row">
           <button data-player-control="subtitle-retry" type="button" hidden>Reintentar subtítulos</button>
           <span id="subtitleSyncStatus" data-player-part="subtitle-sync-status" role="status" aria-live="polite">Requiere subtítulos y audio en inglés</span>
         </div>
         <div class="player-timeline">
           <label class="sr-only" for="playerSeek">Posición del vídeo</label>
           <input class="player-seek" id="playerSeek" data-player-control="seek"
             type="range" min="0" max="1000" step="1" value="0">
           <output class="player-clock" data-player-part="clock">0:00 / 0:00</output>
         </div>
         <div class="player-control-row">
           <button data-player-control="play" type="button" aria-label="Reproducir" title="Reproducir (espacio)">▶</button>
           <button data-player-control="mute" type="button" aria-label="Silenciar">VOL</button>
           <label class="sr-only" for="playerVolume">Volumen</label>
           <input class="player-volume" id="playerVolume" data-player-control="volume"
             type="range" min="0" max="1" step="0.05" value="1">
           <div class="player-audio">
             <label for="playerAudio">Audio</label>
             <select id="playerAudio" data-player-control="audio" disabled>
               <option>Buscando pistas…</option>
             </select>
           </div>
           <button data-player-control="retry" type="button" hidden>Reintentar</button>
           <span class="control-spacer"></span>
           <button data-player-control="captions" type="button"
             aria-label="Activar o desactivar subtítulos" aria-pressed="true"
             ${selectedSubtitle ? "disabled" : 'disabled title="Subtítulos no disponibles"'}>CC</button>
           <button data-player-control="subtitle-sync" type="button" aria-pressed="false"
             aria-label="Sincronización automática de subtítulos en inglés"
             aria-describedby="subtitleSyncStatus" disabled>Auto-sync</button>
           <button data-player-control="fullscreen" type="button"
             aria-label="Pantalla completa" title="Pantalla completa (F)">⛶</button>
         </div>
       </div>
       </div>
     ${marathonPanel(marathon)}
     <details class="compatibility">
       <summary>Problemas de reproducción</summary>
       <p>Mantén Stremio abierto en el PC: prepara el audio compatible para cada pantalla. En Audio puedes elegir entre las pistas que incluye la fuente. Si falla, pulsa Reintentar; si el vídeo sigue sin reproducirse, elige otra fuente en Stremio.</p>
     </details>`,
    "",
    "watch",
    "/player.js",
  );
}

export function errorPage(status, message) {
  return layout(
    `Error ${status}`,
    `<div class="page-intro">
       <p class="eyebrow">Error / ${status}</p>
       <h1>No se pudo completar la solicitud.</h1>
       <p class="notice error" role="alert">${escapeHtml(message)}</p>
       <div class="error-actions"><a class="button secondary" href="/watch">Volver al reproductor</a></div>
     </div>`,
    "",
    "error-page",
  );
}
