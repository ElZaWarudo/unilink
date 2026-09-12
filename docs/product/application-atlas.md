---
atlas_schema_version: 1
status: "draft"
verified_source_commit: "64c910b2223b984b5f1ca9b07ce111c7d68e40e5"
application_fingerprint: "sha256:33ff5add98dfc4bc41f871902417770c34733f7cb44ce2dc2632c0802e88f675"
tracked_paths: ["src", "src-tauri", "desktop", "assets", "scripts", "test", "README.md", "package.json", "package-lock.json", "start-unilink.cmd", "start-unilink.sh", ".github"]
excluded_paths: ["docs/product/application-atlas.md", "docs/audits", "src-tauri/gen", "src-tauri/target", "src-tauri/binaries", "src-tauri/icons/android", "src-tauri/icons/ios"]
last_verified_at: "2026-09-12"
---

# Application Atlas

This atlas records source facts and bounded verification at the commit above. **Declared** means README or user intent; **Code** means implementation inspected, not reproduced here; **Observed** requires runtime evidence; **Inferred** is a hypothesis; **Unverified** is an explicit gap. Paths below are repository-relative evidence references. Lead-provided runtime observations are recorded below and in `docs/product/polish-evidence.md`; they were not reproduced independently by the cartographer. The lead accepts reduced evaluation scope: source coverage across declared platforms and browser runtime on Windows, with Linux/native installation/accessibility gaps explicit. Historical baseline observations remain labeled separately.

## 1. Intent

- Product promise [Declared]: Start playback in Stremio and continue in a browser on another device on the same local network; run quietly from the system tray. Source: README opening and Features, inspected 2026-09-12.
- Primary user [Inferred]: A person operating a Windows or Linux host who wants to watch on a phone, tablet, TV, or another computer. README identifies these devices but does not define a release audience.
- Primary job [Declared]: Configure Torrentio, install the add-on, select a Unilink source in Stremio, and open the stable second-screen URL. Source: README Getting started.
- Primary action [Declared]: Select a result beginning with Unilink in Stremio. Success signal [Inferred]: Selected content plays with audible selected audio and usable subtitles at the second-screen URL.
- Deliberate constraints [Declared]: Trusted LAN only; no authentication on watch page; Stremio Desktop remains open; no OS autostart; Windows/Linux tray app; speech sync is optional and English-only; account synchronization exports position rather than importing resume state or marking episodes watched.
- Unacceptable outcomes [Declared]: README says not to expose the server port to the Internet and treats the account configuration file as private. Other release acceptance criteria remain unconfirmed.
- Current work intent [Declared]: User requested a full app polish headed toward final product deployment, 2026-09-12. Distribution audience and target release platforms await lead confirmation.

## 2. Platforms and environments

| ID | Platform/environment | Supported | Inputs | Constraints | Evidence |
| --- | --- | --- | --- | --- | --- |
| PLAT-01 | Windows 10+ host | Declared | Tray, default browser, clipboard | Stremio required; private-network firewall access | README; src-tauri/src/lib.rs |
| PLAT-02 | Linux desktop host | Declared | AppIndicator tray, default browser | AppIndicator support; native build dependencies; Linux package built on Linux | README; src-tauri/Cargo.toml |
| PLAT-03 | LAN browser viewer | Declared | Mouse, keyboard, touch | MediaSource/HLS.js or native HLS; same trusted network | README; src/player.js |
| PLAT-04 | Direct Node developer server | Code | CLI and browser | Node >=20; default bind 0.0.0.0:17891; data/config.json unless overridden | src/index.js; package.json |
| PLAT-05 | Speech host runtime | Code | Optional host setup page or developer command | Python >=3.10; downloaded base.en model; FFmpeg/FFprobe; CPU worker | src/speech-setup.js; src/speech/worker.py |
| PLAT-06 | macOS/mobile native application | Unverified / not declared | Icon assets exist | Tauri contains generic icon assets; no declared support or reproduced package | src-tauri/icons; README |

## 3. Actors and permissions

| ID | Actor/role | Goal | Can | Cannot | Evidence |
| --- | --- | --- | --- | --- | --- |
| ACT-01 | Host operator | Configure and serve content | Configure Torrentio; activate source; choose subtitle source/delay; connect/disconnect Stremio; tray lifecycle | Administrative routes reject remote sockets | Code: src/server.js; src/stremio-routes.js |
| ACT-02 | Trusted LAN viewer | Watch active source | Play/seek/audio/CC/fullscreen; local auto-sync; queue changes; progress reports | Configure/activate or administer Stremio account remotely | Code: src/server.js; src/player.js |
| ACT-03 | Stremio client/add-on consumer | Discover and activate source | Fetch manifest and decorated stream list; open loopback activation URL | Candidate IDs expire with process memory/eviction | Code: src/streams.js; src/server.js |
| ACT-04 | Untrusted website/network client | No declared user role | Public add-on/media API exposure varies by route | Watch/configure/progress/speech/account origin checks; loopback admin checks | Code: src/server.js; src/stremio-routes.js; test/server.test.js |

There are no plan, tenant, password-login, billing, or application-user roles in inspected source. A linked Stremio account is optional host state, not viewer authentication.

## 4. Surface and navigation map

| ID | Surface | Entry | Exits/return | Roles | Route/window | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| SURF-01 | Native tray | Launch executable | Configure, install, watch, copy URL, start/stop/restart, quit | ACT-01 | No normal native window | Code: src-tauri/src/lib.rs; tauri.conf.json windows=[] |
| SURF-02 | Configuration | First launch or tray/browser link | Save with inline feedback; stable viewer URL copy/open; Stremio protocol install; optional account and speech setup | ACT-01 | GET/POST /configure; /api/speech-setup | Code: src/pages.js configurationPage; src/speech-setup.js |
| SURF-03 | Source activation and handoff | Stremio decorated result | Copy/open watch URL; preparation status; apply subtitles; close tab | ACT-01, ACT-03 | GET /activate/:id redirects to GET /session; POST /settings | Code: activationPage; src/server.js |
| SURF-04 | Waiting screen | Stable URL with no active source | Bounded status polling becomes active player | ACT-02 | GET /watch | Code: watchPage; reload only when active |
| SURF-05 | Active player | /watch with active source | Playback controls; compatibility disclosure; source-change reload | ACT-02 | GET /watch; /player.js; /hls.js | Code: watchPage; startPlayer |
| SURF-06 | Episode queue/countdown | Series active on player | Reorder/remove/undo last removal, next episode, autoplay toggle/cancel; busy feedback and focus continuity | ACT-02 | Embedded on /watch | Code: marathonPanel; src/player.js |
| SURF-07 | Error page | Invalid/forbidden/not-found request | Return to /watch | All | Server-generated HTML | Code: errorPage |
| SURF-08 | Add-on API | Installation/discovery | Stremio source list and activation browser | ACT-03 | /manifest.json; /stream/(movie|series)/:id.json | Code: src/server.js; src/streams.js |
| SURF-09 | Media and state APIs | Player/host integrations | JSON/media consumed by callers | ACT-01/02/03 | /api/status; /media; /hls/:instance/:version/*; /subtitle/:index.vtt; /api/progress; /api/subtitle-sync; /api/speech-setup; /api/marathon/*; /api/stremio/* | Code: src/server.js; src/stremio-routes.js |

desktop/index.html is an empty Spanish-language frontend asset; actual user pages are rendered by the Node server. No separate search/library/catalog surface exists in inspected source.

## 5. Flow registry

| ID | Flow | Actor | Frequency | Consequence | Entry | Completion | Surfaces | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FLOW-01 | Onboard and install add-on | ACT-01 | First use [Declared] | Persist provider configuration | Launch/configure | Saved configuration and Stremio install request | 01,02,08 | README; configurationPage; needs_onboarding |
| FLOW-02 | Select and hand off source | ACT-01/03 | Normal session [Inferred] | Changes source for every viewer | Stremio Unilink result | Activation page displays stable watch URL | 03,04,05,08 | activate route; StreamRegistry |
| FLOW-03 | Play and resume | ACT-02 | Normal session [Inferred] | Media delivery and local history | /watch | Playback/seek with selected audio and retained position | 04,05,09 | startPlayer; startAudioPlayback |
| FLOW-04 | Select and tune subtitles | ACT-01/02 | As needed [Inferred] | Host preference shared across viewers | Activation settings/player CC | Selected captions rendered at manual delay | 03,05 | /settings; subtitleSelection; cueAtTime |
| FLOW-05 | Match English speech | ACT-02 | Opt-in [Declared] | Local compute and temporary audio | Auto-sync inglés | Supported scene correction or unchanged uncertain scene | 05,09 | SubtitleSync; speech worker; controller |
| FLOW-06 | Continue series | ACT-02 | Episodic viewing [Declared] | Shared active source advances | Queue/countdown | Next prepared episode active | 05,06,09 | marathon.js; registry; player |
| FLOW-07 | Link account and save position | ACT-01/02 | Once plus playback [Declared] | Private account credential and external library position | Configure / Conectar Stremio | Linked status; saved progress status | 02,05,09 | stremio-sync.js; stremio-routes.js |
| FLOW-08 | Manage server lifecycle | ACT-01 | As needed [Declared] | Interrupts viewers; clears in-memory source | Tray | Server status changes or app quits | 01 | lib.rs |

### FLOW-01 — Onboard and install
- Preconditions: Host app and Stremio installed; configured Torrentio manifest available.
- Before/during/after [Code]: Missing saved manifest opens browser onboarding after server readiness; URL form normalizes HTTP(S)/stremio protocol and manifest suffix; POST returns JSON for enhanced save or redirects for normal form navigation. Setup provides the stable viewer URL, copy/open actions and Unilink source-selection steps. Account linking and speech setup are optional.
- Failure/recovery [Code]: Pending save and inline result retain input; user can resubmit. Native startup failures remain visible in the tray with bounded repair guidance.
- Data/context: Manifest URL in host config; save merges other preferences. External protocol installation success is Unverified.

### FLOW-02 — Select and hand off
- Preconditions: Configured add-on and a supported HTTP(S) source or torrent info hash.
- Before/during/after [Code]: Stream discovery decorates candidates; loopback activation changes active source/version and redirects to read-only /session while optional subtitles and metadata load in the background. Handoff reports preparation and supplies persistent LAN URL. Waiting and active viewers poll status with bounded requests.
- Failure/recovery [Code]: Upstream discovery returns empty streams with warning header; subtitles/metadata may leave warnings; missing candidate becomes error page. Selecting a different source restarts flow.
- Data/context: Candidates and source/queue are process memory; activation affects all viewers. Copy fallback selects text if clipboard fails.

### FLOW-03 — Play and resume
- Preconditions: Active source; Stremio HLS service reachable; supported browser.
- Before/during/after [Code]: Browser prepares HLS audio, exposes play/pause/seek/volume/audio/CC/fullscreen, stores per-content resume position and per-browser audio preference. Native HLS selects playlist audio; HLS.js chooses track.
- Failure/recovery [Code]: Preparation error offers Reintentar and compatibility help; failure text has separate space above controls. Controls remain visible while paused, ended or failed. Storage exceptions are reported separately from account progress and do not stop playback; stale versioned media requests return 409. Local resume is not imported from Stremio.
- Data/context: Media crosses host-to-browser LAN; localStorage retains position/audio. Source identity and server instance invalidate stale playback context.

### FLOW-04 — Subtitle preference and timing
- Preconditions: Discovered tracks for selected content.
- Before/during/after [Code]: Host chooses language/source and delay; applies settings; active viewer receives update and displays custom captions. Viewer CC toggles caption visibility.
- Failure/recovery [Code]: No-track text; failed settings status allows resubmit; stale source/session forms return 409 without changing the current source. Subtitle loading failure exposes a bounded same-track retry without restarting media. Delay stepper resets to zero.
- Data/context: Host preference persists language, ID, source index, delay; source alternatives filtered by selected language. Manual delay bounded ±30 seconds.

### FLOW-05 — English speech matching
- Preconditions: Optional engine installed through host configuration or developer command; Python >=3.10 on the host; English subtitles and English or unknown-language audio; opt-in at current screen.
- Before/during/after [Code]: API checks availability; one host job analyzes up to 120 seconds, uses recognized phrase anchors, and returns bounded correction without transcript. Corrected cues apply only in supported region; manual delay adds to result.
- Failure/recovery [Code]: Busy, unavailable, insufficient, stale, cancelled, and error outcomes; pending work cancelled on seek/source/track change or opt-out; uncertain sections retain original timings.
- Data/context: Temporary host audio/subtitles cleaned after job; 32-job host cache and 32-correction client cap; 180-second job deadline; local per-screen opt-in is not persisted.

### FLOW-06 — Series queue
- Preconditions: Standard IMDb series ID; metadata and source provider available.
- Before/during/after [Code]: Prepares default five next episodes and up to three sources each; viewer reorders/removes; ten-second default countdown can be cancelled; advance changes shared active source and refills queue.
- Failure/recovery [Code]: Unprepared entries and warnings remain visible; mutations show busy state and preserve queue focus. Origin and source/session guards reject stale writes; current episode continues on preparation failure. Last removal can be undone until a new source is activated.
- Data/context: Autoplay/countdown/queue-size preference persists; queue and single-removal undo are process memory. Reordering/removing affects all viewers; undo may temporarily restore one episode above the target queue size after refill.

### FLOW-07 — Stremio account/progress
- Preconditions: Host operator can approve external Stremio device link; playback identity valid.
- Before/during/after [Code]: Connect opens external approval page and polls; pending can be cancelled; account credential remains host-side; browser submits position every 15 seconds and on pause/exit.
- Failure/recovery [Code]: Pending/expired/disconnected/error/synced UI states; retry messaging; reconnect available. Browser-local resume continues when account service fails.
- Data/context: Credential in host configuration; outgoing account progress only; existing watched markers preserved. Disconnect removes saved connection. Actual live account mutation is Unverified in this atlas.

### FLOW-08 — Host lifecycle
- Preconditions: Running native app.
- Before/during/after [Code]: Single-instance plugin; serialized background lifecycle operations; starting/running/stopping/stopped/failure tray states; external-server ownership guards; owned Windows process-tree termination and async quit cleanup. Release Windows executable requests the GUI subsystem.
- Failure/recovery [Code]: Bounded tray reasons distinguish port conflict, missing server, data-folder and startup failure; retry remains available. No configured autostart or updater found. Linux descendant cleanup and live tray interaction remain unverified.
- Data/context: Persistent config survives process restart; active source/queue and transient jobs do not. Install/upgrade/uninstall behavior is Unverified.

## 6. State catalog

| ID | Surface/flow | State | Expected behavior | Observed/code/unverified | Evidence |
| --- | --- | --- | --- | --- | --- |
| STATE-01 | Configure | Empty, invalid, saved | Required URL; inline validation; saved notice | Code | configurationPage; configure routes |
| STATE-02 | Account | Checking, pending, connected, expired, failure, disconnected | Status text, appropriate connect/cancel/disconnect and external continuation | Code | configurationPage |
| STATE-03 | Waiting | No active source | Instructions and periodic activation detection | Code | watchPage |
| STATE-04 | Player | Preparing, playing, paused, seeking, muted, fullscreen, failure | Controls/status; retry; source change handling | Code | startPlayer; startAudioPlayback |
| STATE-05 | Captions | Loading, ready, absent, failed, hidden, manually shifted | Caption control reflects availability | Code | src/player.js |
| STATE-06 | Auto-sync | Disabled, ready, working, busy, insufficient, unavailable, error, stale | Opt-in state, bounded corrections, recovery messages | Code | subtitle-sync.js; controller |
| STATE-07 | Queue | Prepared, unavailable, empty, countdown, cancelled, stale advance | Visible status and available controls | Code | marathonPanel; registry |
| STATE-08 | Network/permissions | Upstream offline, LAN admin rejection, stale media URL | Error/status with recovery where provided | Code | server.js; stremio-routes.js |
| STATE-09 | Tray | Starting, running owned, running external, stopping, stopped, failed | Serialized actions; bounded error/retry; quit waits for cleanup; external ownership respected | Code/unit tests | lib.rs Lifecycle; actual native interaction unverified |
| STATE-10 | Extreme content/input | Long labels, many tracks, narrow viewport, keyboard/screen reader | Narrow layout and keyboard focus observed; long-label/high-volume/AT behavior remains unverified | Partial | Lead browser samples; CSS/control implementation |
| STATE-11 | Speech setup | Idle, checking, environment, dependencies, model, verifying, ready, error | Fixed installation stages, bounded local runtime probe, repair/retry; host-only administrative route | Code/tests and simulated browser installer | src/speech-setup.js; pages.js; server.js |

## 7. Data and context lifecycle

| Data/context | Created | Persisted | Restored | Cleared | Risk | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Torrentio manifest and subtitle/marathon settings | Configure/settings requests | Atomic serialized JSON saves | ConfigStore load | Overwrite/new selection | Provider URL can contain private configuration | Code: config.js |
| Stremio auth key | Approved account link | Same host config, Linux creation mode 0600 | Host sync initialization | Disconnect | Credential; never send to viewer | Code: config.js; stremio-sync.js |
| Active source/candidates/queue | Add-on discovery/activation | Memory only | Not across server restart | Eviction/restart/source activation | Shared LAN viewers change together | Code: streams.js |
| Browser resume/audio preference | Playback and audio selection | localStorage | Same browser/origin | Completion removes resume; storage deletion | Viewing context on device | Code: player.js |
| Speech job/correction | Opt-in | Memory caches; temporary host files | Same source/window cache within TTL | Cancel/timeout/cleanup/expiry | Local audio and subtitle copies | Code: subtitle-sync.js; worker.py |
| Tokens/server identity | Server construction | Process only; page embeds appropriate token | New page load | Process restart | Distinct administrative/progress capability | Code: server.js |

## 8. External and asynchronous boundaries

| Boundary | Trigger | Pending signal | Success | Failure/retry | Evidence |
| --- | --- | --- | --- | --- | --- |
| Torrentio HTTP | Discovery and queue preparation | Request in flight; queue availability | Decorated sources | Empty list/warning, later preparation | Code: server.js |
| Stremio media/HLS/subtitle conversion | Browser playback/captions | Player preparation message | Media/audio/captions | Retry or alternate source | Code: hls.js; server.js; player.js |
| OpenSubtitles v3 | Activation/episode advance | Activation waits | Normalized subtitle list | Warning/no tracks | Code: subtitles.js; server.js |
| Cinemeta-compatible metadata | Series activation | Activation waits | Episode queue | Warning; current source remains | Code: marathon.js; server.js |
| Stremio account API/link site | Connect/progress | Pending/saving states | Linked/synced | Expiration/retry/reconnect | Code: stremio-sync.js |
| Local Python + FFmpeg/FFprobe | Auto-sync opt-in | Working status | Scene offset | Cancellation/timeout/insufficient | Code: subtitle-sync.js; speech/worker.py |
| Python package/model download | Optional setup command | Terminal output | Host runtime files | Setup process failure | Code: scripts/setup-subtitle-sync.js |
| OS protocol/default browser/clipboard | Tray and install/handoff links | Browser/protocol handling | External destination/copy | Clipboard fallback in web page; native result unverified | Code: lib.rs; pages.js |

## 9. Destructive and high-consequence actions

| Action | Consequence | Reversible | Protection | Safe test path | Evidence |
| --- | --- | --- | --- | --- | --- |
| Source activation/episode advance | Replaces every viewer's source | Reselect previous available source | Loopback activation; expected queue ID | Synthetic source registry | Code: server.js; streams.js |
| Stop/restart/quit | Interrupts playback, clears memory | Restart and reactivate | Owned-child menu gating | Isolated server/native fixture | Code: lib.rs |
| Disconnect account | Deletes saved link | Reconnect externally | Loopback/token/origin | Fake account service/temp config | Code: stremio-routes.js |
| Progress report | Changes external account position | Later position update | Token/identity checks | Mock account boundary | Code: stremio-sync.js; tests |
| Save provider config | Replaces stored URL | Save previous URL | Loopback and validation | Temporary config with public fixture | Code: config.js; server.js |

No payment, publication, production database, or cloud deployment interface appears in inspected application source.

## 10. Content and scale envelopes

| Surface | Empty | Typical | Long/extreme | High volume | File/input limits | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Source/provider | No configured URL or streams | Movie/episode result | URL suffix/scheme validation | Candidate memory cap 250 | Forms 32,768 bytes | Code: config.js; streams.js; server.js |
| Subtitles | No tracks | Language/source options | Caption wrapping in CSS; extreme runtime unverified | Normalize max 80 tracks | Manual delay ±30 sec | Code: subtitles.js; pages.js |
| Queue | No later episodes | Default 5 items | Long titles runtime unverified | Queue preference 1–10; metadata list capped 500 | Countdown 3–30 sec | Code: config.js; server.js |
| Speech | Missing engine/anchors | 120-second scene | Media duration 30 sec–8 hr; selected audio index 0–15 | One worker; 32 cached jobs | API body 2,048 bytes; subtitle data 2MB; worker output 32KB | Code: server.js; subtitle-sync.js |
| Progress | No account or identity | Periodic position | Invalid time rejected | Serialized/coalesced updates | API JSON 2,048 bytes | Code: stremio-routes.js; stremio-sync.js |

## 11. Platform, input and accessibility expectations

| Platform/flow | Keyboard | Touch | Focus | Back/deep link | Reduced motion | Assistive tech | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Web forms | Native form controls | Responsive CSS | Focus-visible styles | Configure and activation routes | CSS reduced-motion rule | Labels, alerts/status regions | Code: pages.js; inline save and status recovery observed; actual AT unverified |
| Player | Space/play, F/fullscreen and keyboard handlers | Double-tap ±10 sec; fullscreen tap controls | Focusable player and controls | /watch stable; reload on source change | CSS reduced-motion rule | ARIA names/status; visual caption element aria-hidden | Code: player.js; pages.js; desktop/narrow/keyboard samples observed; physical touch/AT unverified |
| Queue | Native buttons | Click/tap buttons | Dynamic updates | Embedded watch surface | CSS shared rule | Button labels include episode titles; countdown live region | Code: pages.js; player.js |
| Native tray | OS menu conventions | OS-dependent | OS-managed | Protocol/default-browser launch | Not applicable to static menu | OS tray menu semantics | Code: lib.rs; actual AT unverified |

## 12. Coverage ledger

Lead runtime sample [Observed, reported 2026-09-12; baseline 8a320b9]: `/configure` on isolated instance port 17892 shows empty Manifest field, Save and Install actions, optional account connection, and endpoint footer, with no visible path to watch. A real HTTP invalid-manifest POST on clean instance 17894 returns 400 and the expected message; browser form click/Enter did not navigate, so native form submission remains unverified. Clean `/watch` renders the waiting instructions. Active player sample on 17892 previously produced 21 speech anchors and a +1.44-second offset; disabling auto-sync restored original timing. Desktop and 390-pixel viewport samples had no horizontal overflow. Player controls hid after three seconds even while paused. These samples do not establish broad browser or media compatibility.

| Item | Status | Evidence | Last checked | Gap/next probe |
| --- | --- | --- | --- | --- |
| Declared product/platforms | covered | README and user request | 2026-09-12 | Release audience remains open |
| Reachable routes/surfaces | covered for source inventory | src/server.js, pages.js, lib.rs | 2026-09-12 | Runtime walkthrough pending |
| Primary flows/persistence/integrations | partial | Source and test-file inventory | 2026-09-12 | Reproduce with isolated fixtures and real playback |
| Automated tests | covered for existing candidate suites | Lead receipts: 116 JavaScript, 10 Python speech and 8 release-profile Rust tests passed; syntax/format passed | 2026-09-12 | Test harnesses do not replace the platform/runtime gaps below |
| Empty/loading/error/extreme/volume | partial | Code states and explicit bounds | 2026-09-12 | Runtime samples needed; not claimed as tested |
| Desktop/narrow/keyboard/touch/AT | partial | Real browser desktop/narrow layout, paused/fullscreen controls, volume recovery and queue focus | 2026-09-12 | Physical touch/device matrix and actual assistive-tech check |
| Windows packaging/install/lifecycle | partial | Optimized 0.2.0 native build, MSI/NSIS, GUI PE subsystem and packaged-server smoke passed | 2026-09-12 | Actual native tray and clean-machine install/upgrade/quit checks |
| Linux package and tray/browser | unverified | Declared support; build paths | 2026-09-12 | Linux environment evidence |
| Distribution/release automation | partial | package.json and Tauri config version 0.2.0; no .github directory at baseline | 2026-09-12 | Local Windows candidate; signing and distribution destination unverified |
| Live external account mutation | unverified | Local test suites exist | 2026-09-12 | Do not perform without authorized safe account |
| Public Internet hosting/native mobile | out-of-scope for declared promise | README trusted-LAN constraint | 2026-09-12 | New intent required to change scope |

## 13. Open intent questions and conflicts

- Who receives the release and which host platforms must be release-tested? Owner: product-polish lead/user; user requested deployment direction without distribution details.
- Optional speech installation now has an in-product host path without a developer checkout. Python 3.10+ and Stremio remain explicit prerequisites; clean-machine installation still needs verification.
- Success tolerances for playback startup, recovery time, and subtitle timing have not been declared. Prior speech verification belongs to separate evidence and is not reproduced by this cartography pass.
- Release UI now consistently names Unilink. The source-selection step inside Stremio itself still needs a native walkthrough.

## 14. Change log

- 2026-09-12: Created source-grounded baseline for full-product polish. Stable IDs cover nine surfaces, eight flows, six platform dispositions, and four actor dispositions. Runtime verification remains explicitly partial/unverified; draft status is intentional.
- 2026-09-12: Remediated release findings and refreshed source facts. Candidate browser evidence on disposable port 17895: inline configuration save, optional installer pending/failure/retry using a fake installer, subtitle retry after HTTP 503, queue remove/undo with real keyboard focus preservation, paused controls, volume-zero recovery, desktop fullscreen caption spacing, and narrow player layout without horizontal overflow. Synthetic local media avoids using personal viewing content. These observations do not establish native tray, Linux, clean-machine or assistive-technology behavior.
