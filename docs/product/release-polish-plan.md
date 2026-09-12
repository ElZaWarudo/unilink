# Windows release polish

Baseline: `8a320b9`. Request: full product polish toward deployment. The release
candidate targets Windows; Linux receives source review only. Publication,
signing and clean-machine installation remain separate verification boundaries.

## Requirements and acceptance

1. Protect session mutations. Reject cross-origin queue/settings requests and
   stale player or settings submissions before changing any state. Delayed
   subtitle/episode requests must never overwrite a newer selection. An expired
   activation link must preserve the current queue.
2. Complete setup and handoff. Use the actual Stremio source name, Unilink;
   show the stable viewing URL and next steps; mark account linking optional.
   Acknowledge source selection while optional metadata loads, with an accurate
   preparation state and a stable page that can be revisited safely.
3. Make playback controls dependable. Keep controls visible while paused or
   failed, restore audible volume on unmute from zero, expose readable seek
   values and keyboard focus, and retry subtitle loading without restarting
   playback. Report local and account progress honestly.
4. Preserve queue continuity. Acknowledge pending operations immediately,
   prevent repeated submissions, preserve keyboard focus through rendering,
   and allow the last removal to be undone within the current session.
5. Complete optional English speech setup. Provide a host-only in-product
   installation action with progress, explicit Python prerequisite, bounded
   execution and retry. Keep model processing local, the English-only scope,
   manual timing and conservative match acceptance.
6. Make native lifecycle failures recoverable. Distinguish starting, intentional
   stop and failure, serialize lifecycle operations, offer an actionable failure
   state, and build Windows release executables without a console window.
7. Verify and package the final candidate. Run behavior tests, syntax checks,
   speech tests, Rust tests, browser checks and Windows packaging. Independently
   simplify/review the changes, address justified findings, update the atlas,
   and record artifact hashes and remaining platform evidence gaps.

## Implementation ownership

- Host/session: `src/server.js`, `src/pages.js`, `src/streams.js`, related tests.
- Playback: `src/player.js`, player tests. Coordinate DOM hooks and session fields
  with host/session work before integration.
- Speech setup: reusable setup module, CLI wrapper and focused tests; host/session
  work owns HTTP/UI wiring.
- Native: `src-tauri/src/lib.rs`, `src-tauri/src/main.rs` and native tests.
- Lead: integration, release documentation, authoritative verification, browser
  evidence and local commits. Workers do not run git or overwrite others' work.

## Evidence

The twelve-dimension Council completed against the factual atlas and packet.
Its validated overlay requires a six-factor Court pass limited to setup,
handoff and native recovery. Findings are heuristic predictions of usability
burden, not human workload measurements. Final cause-level synthesis is recorded
in the accompanying audit report before implementation begins.

## Release validation and rollback

Use disposable profiles and ports for candidate checks. Preserve the existing
installed app and user configuration. Verify first launch, save/install handoff,
source selection, pause/resume, subtitle retry, queue changes, and stop/restart.
An unintended inability to play or preserve settings is a rollback trigger:
close the candidate and retain the previous installer/configuration. The local
operator owns this validation; no telemetry or public deployment channel is
configured. Native tray interaction, Linux and clean-machine installation need
explicit evidence before claiming those environments release-ready.
