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
    main { padding: var(--space-7) 0 var(--space-9); }
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
      bottom: 104px;
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
      padding: var(--space-3);
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
      margin-top: var(--space-2);
    }
    .player-control-row .control-spacer { flex: 1; }
    .player-controls button {
      min-width: 44px;
      min-height: 40px;
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
    .player:fullscreen video {
      width: 100%;
      height: 100%;
      max-height: none;
    }
    .player:fullscreen.is-controls-hidden,
    .player:fullscreen.is-controls-hidden video {
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
        bottom: 98px;
        max-width: 90%;
        font-size: 1rem;
      }
      .player-controls { padding: var(--space-2); }
      .player-volume { display: none; }
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
  ${moduleSrc ? `<script type="module" src="${escapeHtml(moduleSrc)}"></script>` : ""}
</body>
</html>`;
}

export function configurationPage({
  currentUrl = "",
  saved = false,
  error = "",
  manifestUrl,
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
       <p class="lede">Pega el manifest que ya utilizas en Torrentio. Unilink solo lo guarda en este ordenador para añadir la acción «Servir en red».</p>
     </div>
     ${message}
     <form class="workbench" method="post" action="/configure">
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
     </form>
     <p class="endpoint-note">Endpoint local · <code>${escapeHtml(manifestUrl)}</code></p>`,
    "",
    "configure",
  );
}

export function activationPage({
  watchUrl,
  active,
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
    ? `<form method="post" action="/settings">
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
             <label for="subtitleDelay">Sincronización</label>
             <input id="subtitleDelay" name="subtitleDelay" type="number" min="-30" max="30" step="0.1"
               inputmode="decimal" aria-describedby="delayHelp"
               value="${escapeHtml(active.playbackSettings?.subtitleDelay ?? 0)}">
             <span class="field-help" id="delayHelp">Segundos: usa negativo para adelantar.</span>
           </div>
         </div>
         <div class="actions"><button type="submit">Aplicar subtítulos</button></div>
       </form>`
    : "";
  const copyScript = `const copyButton=document.querySelector("#copyWatchUrl");
     const copyInput=document.querySelector("#watchUrl");
     const copyStatus=document.querySelector("#copyStatus");
     const languageSelect=document.querySelector("#subtitleLanguage");
     const sourceSelect=document.querySelector("#subtitleSource");
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
     ${subtitleWarning ? `<p class="notice error">${escapeHtml(subtitleWarning)}</p>` : ""}
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
    copyScript,
    "activation",
  );
}

function marathonPanel(marathon) {
  if (!marathon?.active) {
    return "";
  }
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
  const empty = items.length
    ? ""
    : '<p class="marathon-empty" data-marathon-empty>No hay más episodios preparados.</p>';
  const warning = marathon.warning
    ? `<p class="marathon-warning" data-marathon-warning role="status">${escapeHtml(marathon.warning)}</p>`
    : '<p class="marathon-warning" data-marathon-warning role="status" hidden></p>';
  const autoplayLabel = marathon.autoplay
    ? "Parar después de este episodio"
    : "Activar reproducción automática";
  return `<section class="marathon-panel" data-marathon aria-labelledby="marathonTitle">
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
    <ol class="marathon-list" data-marathon-list>${queue}</ol>
    ${empty}
    <div class="marathon-countdown" data-marathon-countdown role="status"
      aria-live="assertive" hidden>
      <p data-marathon-countdown-text></p>
      <button class="secondary" type="button"
        data-marathon-action="cancel-countdown">Cancelar cuenta atrás</button>
    </div>
  </section>`;
}

export function watchPage({
  active,
  serverInstanceId = "",
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
           <li>Elige una fuente marcada como «Servir en red».</li>
           <li>La reproducción aparecerá aquí sin cambiar de dirección.</li>
         </ol>
       </section>`,
      `setTimeout(() => location.reload(), 3000);`,
      "watch waiting",
    );
  }

  const presentation = streamPresentation(active);
  const subtitles = active.subtitles ?? [];
  const preferredLanguage =
    active.playbackSettings?.subtitleLanguage ?? "es";
  const preferredSubtitleId =
    active.playbackSettings?.subtitleId ?? "";
  const preferredSubtitle = subtitles.findIndex(
    (subtitle) =>
      subtitle.language === preferredLanguage &&
      subtitle.id === preferredSubtitleId,
  );
  const languageFallback = subtitles.findIndex(
    (subtitle) => subtitle.language === preferredLanguage,
  );
  const selectedSubtitleIndex =
    preferredSubtitle >= 0
      ? preferredSubtitle
      : languageFallback >= 0
        ? languageFallback
        : 0;
  const selectedSubtitle = subtitles[selectedSubtitleIndex];
  const subtitleDelay = active.playbackSettings?.subtitleDelay ?? 0;
  const subtitleUrl = selectedSubtitle
    ? `/subtitle/${selectedSubtitleIndex}.vtt?version=${active.version}&delay=0`
    : "";
  const selectedSourceNumber = selectedSubtitle
    ? subtitles
        .slice(0, selectedSubtitleIndex + 1)
        .filter(
          (subtitle) =>
            subtitle.language === selectedSubtitle.language,
        ).length
    : 0;
  const subtitleStatus = selectedSubtitle
    ? `Subtítulos: ${escapeHtml(selectedSubtitle.label)} · fuente ${selectedSourceNumber}`
    : "Sin subtítulos";
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
         <span>Sin transcodificar</span>
         <span>${subtitleStatus}</span>
         <span data-subtitle-delay-state>Delay ${Number(subtitleDelay).toFixed(1)} s</span>
       </div>
     </div>
     <div class="player"
       data-unilink-player
       data-version="${escapeHtml(active.version)}"
       data-server-instance-id="${escapeHtml(serverInstanceId)}"
       data-status-url="/api/status"
       data-subtitle-url="${escapeHtml(subtitleUrl)}"
       data-subtitle-delay="${escapeHtml(subtitleDelay)}"
       data-resume-key="${escapeHtml(resumeKey)}"
       tabindex="0"
       aria-label="Reproductor de ${escapeHtml(presentation.title)}">
       <video controls playsinline preload="metadata" src="/media"
         aria-label="Vídeo de ${escapeHtml(presentation.title)}"></video>
       <p class="player-caption" data-player-part="caption" aria-hidden="true" hidden></p>
       <p class="player-message" data-player-part="message" role="status" aria-live="polite" hidden></p>
       <p class="player-seek-feedback" data-player-part="seek-feedback"
         role="status" aria-live="polite" aria-atomic="true"></p>
       <div class="player-controls" aria-label="Controles de reproducción">
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
           <span class="control-spacer"></span>
           <button data-player-control="captions" type="button"
             aria-label="Activar o desactivar subtítulos" aria-pressed="true"
             ${selectedSubtitle ? "disabled" : 'disabled title="Subtítulos no disponibles"'}>CC</button>
           <button data-player-control="fullscreen" type="button"
             aria-label="Pantalla completa" title="Pantalla completa (F)">⛶</button>
         </div>
       </div>
     </div>
     ${marathonPanel(marathon)}
     <details class="compatibility">
       <summary>Problemas de reproducción</summary>
       <p>Si el navegador no admite el contenedor, el vídeo o el audio, vuelve a Stremio y elige otra fuente.</p>
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
