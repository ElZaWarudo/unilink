# Polish evidence packet — 2026-09-12

Baseline commit: `8a320b9`. Atlas: `docs/product/application-atlas.md`.
User request: full app polish toward final product deployment. Existing product
promise and supported platforms come from README. Release audience is pending;
Windows local packaging is the provisional verification target, with Linux
reviewed in code only. Spanish product language and current dark/mint identity
are the existing conventions.

## Environment and scope

- Windows host; Node/Tauri tray application, browser LAN player.
- All source routes and native lifecycle in scope for code review.
- Test servers: 17892 current media mirrored from original app; 17894 clean
  profile under ignored `build/polish-profile`. Original 17891 remains separate.
- Browser: Codex in-app Chromium, desktop default and 390×844 phone viewport.
- Keyboard and pointer available. Physical TV, Linux, screen-reader speech,
  native tray interactions and clean-machine installation are unverified.
- No publishing, credentials, account connection/disconnection, external messages,
  production data changes, or firewall changes are part of these probes.
- Evaluators are read-only and must not operate shared browser or servers.
  Source/tests may be read. Do not read other evaluators' results.

## Observations

- `/configure` empty: heading “Conecta la fuente.”, Manifest de Torrentio URL
  input, Guardar fuente, Instalar addon en Stremio, optional Stremio account
  section and endpoint footer. No visible route to the waiting player.
- Invalid URL `https://example.com/not-a-manifest` submitted to clean server by
  HTTP returns 400 with the correct manifest-ending explanation. In-app browser
  submit/Enter did not navigate; the field reports valid URL syntax. Browser
  form submission is a verification gap, not an attributed app defect.
- `/watch` empty: “Esperando una película.”, three steps including selecting
  “Servir en red”. `src/streams.js` emits source name “Unilink”.
- Active player: video, timeline, play/mute/audio/captions/fullscreen and English
  auto-sync; controls hide after inactivity, including when paused.
- Real speech run: 21 phrase anchors, +1.44s correction, median ASR agreement
  residual .1645s within subtitle times 460.877–578.526; UI “Tramo sincronizado”.
  Turning off verified false pressed-state and empty status; cue restoration
  covered by tests. No browser console errors in that flow.
- Active 390px-wide phone layout has scrollWidth=clientWidth=390; controls fit.
- Playback section initially says “Progreso guardado en este navegador” and
  “Audio compatible”. The clean mirrored media profile later shows pending
  Stremio progress even though no account is connected (code/HTTP investigation
  needed to attribute root cause).
- Speech setup currently requires `npm run setup:subtitle-sync` from checkout;
  optional worker/model installation is not bundled in the desktop installer.

## Existing evidence and boundaries

- Baseline 89 JavaScript and 10 production speech Python tests passed; Windows
  sidecar packaging passed. New Rust baseline is being collected.
- Prior review fixed stale-response cancellation and evicted-window retry.
- Keep LAN-only scope, loopback-only settings/account access, versioned media,
  original subtitle text, bounded corrections, local speech processing, manual
  delay, browser resume, and conservative failure behavior.
- No independent human subtitle accuracy benchmark. No verified public release
  channel, signing identity, or release audience yet.

## Council contract

Read the atlas and this packet, then inspect code for your assigned dimension.
Use the complete evaluator and cognitive-load contract from
`krt-product-polish-council/references/evidence-and-report-protocol.md`.
Return JSON with evaluator, dimension, rating, confidence, coverage, findings,
keep, unknowns, cross_refs. Cite exact files/lines and distinguish code from
observed. Bound findings to demonstrable issues; empty findings are valid.
