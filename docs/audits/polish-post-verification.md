# Release polish: scoped post-remediation verification

Date: 2026-09-12. Scope: the 15 accepted causes in `docs/audits/release-polish.md`, all twelve contracts in `polish-baseline.json`, and all six contracts in `cognitive-baseline.json`. This is a bounded independent source/test inspection, not a second defect review or a new set of empirical product ratings.

The current atlas includes the candidate changes and a candidate browser observation entry, but its fingerprint still describes the baseline. The lead must refresh final provenance after the implementation settles. Evidence below uses inspected current source and test assertions, not the baseline fingerprint as proof of freshness.

**Status key:** Implemented = correction and relevant assertions are present; final execution remains subject to the lead's test receipt. Browser corroborated = additionally supported by the lead's reported disposable-browser checks, not independently reproduced by this verifier. Partial = a required runtime or artifact acceptance check remains unverified.

## Accepted criteria

| Accepted cause / trace | Status | Current evidence and remaining boundary |
| --- | --- | --- |
| Cross-origin and stale session protection — REL-01, POL-05-01 | Implemented | `src/server.js` applies origin checks to settings and all marathon routes, reads instance/version before mutations, and rechecks captured active identity after asynchronous boundaries. `test/server.test.js:899` exercises foreign origins and stale versions across six mutation routes; `:935` holds configuration loading while the source changes. Queue preservation is asserted. Complete final suite receipt pending. |
| Delayed preparation cannot overwrite newer source — REL-02 | Implemented | Subtitle and series preparation capture active identity and guard completion; refill additionally captures the marathon object. `test/server.test.js:914` defers upstream work, activates a replacement, and checks replacement subtitles/queue remain intact; it also verifies expired activation preserves the queue. `:956` covers concurrent refill reservation and undo. |
| Complete setup handoff and literal Unilink label — POL-01-01, POL-02-01, POL-07-01, CL-S-01, CL-I-01 | Browser corroborated | `configurationPage` renders ordered next steps, server-provided open/copy watch URL, and explicitly optional account linking. Waiting copy matches the emitted Unilink prefix. `test/pages.test.js:6` and `:23` assert the key output; server JSON save/invalid-input test is at `test/server.test.js:67`. Lead reports successful AJAX save. Actual external Stremio protocol installation/source-list walkthrough remains outside this verification. |
| Prompt preparation acknowledgment — POL-08-01, CL-U-02 | Implemented | Activation returns 303 to stable `/session` while optional preparation runs. `playerStatus` exposes preparing; the handoff reports it and polls without reactivating. Deferred-upstream test at `test/server.test.js:914` establishes response before upstream completion. `test/pages.test.js:30` executes the preparation script to check abort-on-pagehide and current-session navigation on persisted pageshow; lead reports pages 4/4 passing. |
| Native failure states, serialization and owned cleanup — POL-03-03, POL-04-02, CL-U-01, CL-R-01 | Partial | `Phase`, `Lifecycle.begin`, `complete`, `complete_quit`, and generation/revision checks distinguish transitions and preserve quit intent. Bounded failure messages cover port, files, permissions and failed stop. Windows cleanup targets only the owned child PID tree. Eight Rust tests include concurrent operation rejection, stale termination, quit during start, and failed cleanup retry. Rust execution and native menu/failure probes were pending at handoff; source coverage alone does not close native acceptance. |
| Zero-volume sound recovery — POL-02-02 | Browser corroborated | Shared `toggleMute` restores `lastPositiveVolume` for button and M shortcut; accessible name uses effective silence. `test/player-dom.test.js:69` asserts both routes and volume/time semantics. Lead reports 0 → unmute → 1 in browser. |
| Honest local/account progress — POL-03-01 | Implemented | Initial page promises future local storage rather than claiming a save; `savePosition` reports actual storage outcome. Separate account messages distinguish unsupported, disconnected, pending and error. DOM storage-failure test at `test/player-dom.test.js:78`; account semantics at `test/stremio-sync.test.js:161`. Live external-account writes remain unverified. |
| Queue acknowledgment and focus continuity — POL-03-02, POL-11-01 | Browser corroborated | `setMarathonBusy` immediately reports/locks mutations; renderer preserves action/item identity and selects a meaningful neighbor after removal. Request identity and revision checks avoid applying stale poll results. Tests at `test/player-dom.test.js:150` and `:175` exercise conflict recovery and pending/focus/undo; lead reports real browser focus after remove/undo. |
| Source-scoped removal undo — POL-05-02 | Browser corroborated | Registry retains one removed prepared item/index; undo restores it; activation clears recovery. `test/streams.test.js:334` checks restoration and invalidation; concurrent refill plus undo is covered by server test `:956`. Lead reports remove/undo in browser. |
| Independent subtitle retry — POL-04-01 | Browser corroborated | `loadSubtitles` exposes retry after failure, aborts/time-bounds requests and rejects superseded generations. Retry uses the same URL without replacing media. `test/player-dom.test.js:98` and `:137` cover retry, supersession and timeout; lead reports HTTP 503 followed by successful retry. |
| Packaged optional speech setup handoff — POL-07-02, POL-12-01 | Partial | Player names host configuration; configuration states Python/Stremio prerequisites and download requirements. Host/token/origin-protected API drives fixed installation stages. `SpeechSetup` deduplicates, bounds installation, probes actual pinned imports/model loading, supports repair/retry, and aborts owned work. Five setup tests cover stages, broken existing dependencies, missing Python, close and deadline; route protection is at `test/server.test.js:44`. Lead browser checks used a fake installer: real clean-machine package/model installation remains unverified. |
| Windows GUI executable — POL-09-01 | Partial | `src-tauri/src/main.rs` sets the Windows GUI subsystem only for non-debug Windows builds. Final rebuilt PE header, installer artifacts, and normal Explorer launch must be checked after the pending package build. |
| Range focus and meaningful values — POL-10-01, POL-10-02 | Implemented | Explicit focus-visible outline survives range box-shadow removal. `updateClock` and `updateVolume` expose formatted time and percent via aria-valuetext; `test/player-dom.test.js:69` asserts values. Actual assistive-technology announcement and keyboard focus appearance remain separate runtime checks. |
| Stable waiting page — POL-08-02 | Implemented | Waiting script uses bounded status polling, retains the document on empty/error responses, and reloads only when active content appears; pagehide abort and persisted pageshow recovery are present. `test/pages.test.js:23` verifies the generated polling path; a timed ten-second browser navigation-count probe was not supplied. |
| Paused/ended/failed controls stay visible — lead observation | Browser corroborated | Hide guards cover pause, end, failure, focus and pointer use. Mobile controls stay below the video outside fullscreen. Tests at `test/player-dom.test.js:78`, `:88`, and `:162` exercise terminal/error/retry states. Lead reports paused controls, 375px no overflow, and fullscreen caption spacing. |

## Twelve-dimension regression sweep

1. **Scope and focus:** required source setup precedes viewer handoff; account and speech remain optional. No catalog or unrelated product workflow was added.
2. **Behavioral consistency:** source terminology and both mute interaction routes now share behavior; explicit shared subtitle submission remains distinct from local playback controls.
3. **Status and feedback:** local/cloud outcomes, queue pending states, source preparation, installer stages and native phase messages have distinct representations. Native presentation still requires runtime evidence.
4. **Non-ideal states:** subtitle retry, setup repair/retry, stale-session guidance, and native failed-stop retention are present; conservative speech fallback remains intact.
5. **User protection:** origin/session checks and source-scoped undo complement existing host restrictions and cancellable autoplay. No routine extra confirmation was introduced.
6. **Interface hierarchy:** existing dark/mint and primary/secondary treatment remain; mobile controls use a separate region below media. Lead reports narrow/fullscreen checks; no new visual-quality score is assigned.
7. **Content and language:** Unilink instructions match source output; English-only setup names the host and prerequisites. Spanish task-oriented copy remains.
8. **Perceived performance:** source handoff no longer awaits optional metadata; waiting/status requests are bounded and serialized where needed. No measured latency improvement is claimed.
9. **Platform conventions:** native lifecycle and release GUI intent are represented in source. Actual Windows launch/menu/install and Linux behavior remain open.
10. **Built-in accessibility:** focus outline, readable slider values, busy/status semantics and queue focus continuity have code/test support; real AT remains unverified.
11. **Context continuity:** queue focus/undo, captured source identities, subtitle request generations, retained invalid configuration input and bfcache recovery preserve task context.
12. **Completeness and seams:** optional speech now has a host setup destination and API; external Stremio install and clean-machine dependency setup still need release-environment verification.

## Six-factor Court regression

Scope remains FLOW-01/02 for a first-time ACT-01 host and FLOW-08 for the host operator. This is a heuristic regression against the original criteria, not measured workload reduction.

| Factor | Regression conclusion |
| --- | --- |
| Memory | No new forced recall identified: stable URL, retained source input, explicit steps and distinct lifecycle actions remain visible. Original empty finding set preserved. |
| Search | CL-S-01's omitted-destination cause is addressed in configuration; copy/open are colocated with the next steps. External protocol completion is still a gap. |
| Integration | CL-I-01's terminology mismatch is addressed by literal Unilink instructions; source title and watch URL remain grouped. Human cross-referencing effort was not measured. |
| Decision | Required source selection and optional account/speech choices remain explicit. No new finding from choice count or interface density. |
| Uncertainty | CL-U-02 has deferred-response and preparation-script evidence. CL-U-01 is implemented in native state handling but remains partially verified pending actual tray failure/recovery observation. |
| Recovery | CL-R-01 now has bounded native cause/retry guidance and preserved ownership/configuration semantics in code. Successful operator recovery from a forced native failure remains unverified. |

## Receipt boundary

No tests, browser actions, native interactions or installers were independently executed in this pass. The lead supplied: disposable port 17895 browser checks above; a 116-test JavaScript run with 115 passing and one newly added VM harness failure subsequently fixed; pages 4/4 passing after the fix. The final full JavaScript run, eight Rust tests and Windows package build were pending when this artifact was written. Replace those pending facts only with their actual receipts.

The remaining release boundaries are final suite/package/PE receipts, native Windows interaction and forced-failure recovery, clean-machine install/upgrade/uninstall, real optional speech setup, Linux runtime/package behavior, actual assistive technology, external Stremio installation/account behavior, and human workload measurement. Nothing here establishes public deployment, signing, cross-platform release readiness, or that user cognitive load was reduced.

## Lead follow-up evidence

The final full JavaScript run passed 116/116, and syntax checks passed. The final
manifest correction passed the 22-test HTTP suite. Real installed speech
readiness passed with a two-minute probe limit after an observed cold model
load exceeded the original ten-second bound. The production setup process
runner cancelled a disposable Windows child and grandchild, with both verified
terminated. These later lead receipts narrow the corresponding pending claims;
they do not convert this independent source pass into an independently executed
runtime test. Final package/native receipts are recorded in
`../releases/0.2.0.md`.
