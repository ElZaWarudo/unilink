# Release polish audit and remediation

The weakest release boundary is session protection: an observed cross-origin
queue update succeeded against a disposable profile. The most repeated usability
causes are incomplete setup guidance and indistinguishable failure states. The
existing player and visual hierarchy provide a sound base; a visual redesign is
not needed to address these findings.

## Scope and evidence

Baseline `8a320b9`; factual map and environment are in
`../product/application-atlas.md` and `../product/polish-evidence.md`.
All twelve independent Council contracts are retained in `polish-baseline.json`.
The overlay checker returned valid, evaluator_count 12, finding_count 19.
Repeated FLOW-01/02 × first-time ACT-01 × I/S/U and FLOW-08 × ACT-01 × R/U
triggered the six-factor Court. Assessors received the factual packet and
triggering tuples without Council conclusions. Their full contracts are retained
in `cognitive-baseline.json`.

Setup docket: new host, occasional Windows keyboard/pointer task, no declared
time pressure; success means a configured source and the stable viewer address
ready on the other device. Selecting a compatible source and sharing a LAN are
necessary task complexity. Matching inconsistent names or finding an omitted
destination are avoidable predicted burdens.

Recovery docket: host operator returning after a start/restart failure; success
means identifying the state and a useful retry or repair path. Distinguishing a
port conflict from missing application files is necessary diagnosis; reconstructing
an invisible failure is avoidable. Native interaction is code-reviewed only.

## Unified backlog

| Priority | Cause and bounded correction | Trace | Acceptance |
| --- | --- | --- | --- |
| P1 | Cross-origin session mutation: enforce origin and current-session guards | REL-01, POL-05-01 | Foreign-origin and stale submissions return rejection without changing settings or queue |
| P2 | Delayed preparation writes into a newer source: check captured identity after awaits | REL-02 | Deferred old subtitle/episode responses leave the new selection untouched |
| P2 | Setup omits viewing handoff and uses the wrong source name | POL-01-01, POL-02-01, POL-07-01, CL-S-01, CL-I-01 | Configuration shows Unilink selection steps and the stable open/copy viewer URL; optional account is explicit |
| P2 | Optional preparation delays acknowledgment | POL-08-01, CL-U-02 | Selection responds before a deferred upstream; stable handoff page shows preparation and refreshes safely |
| P2 | Native stopped/starting/failed states collapse | POL-03-03, POL-04-02, CL-U-01, CL-R-01 | Distinct states, bounded actionable error text, serialized retry/restart and owned-child cleanup |
| P2 | Zero-volume unmute stays silent | POL-02-02 | Both button and keyboard restore a positive volume |
| P2 | Progress status is premature or misleading | POL-03-01 | Storage failure never says saved; unsupported/disconnected account progress does not claim pending cloud writes |
| P2 | Queue changes hide pending state and lose focus | POL-03-02, POL-11-01 | Immediate busy feedback; repeated action blocked; keyboard focus stays on a meaningful queue control |
| P2 | Removal lacks recovery | POL-05-02 | Last removal can be undone in the same source session; new source invalidates undo |
| P2 | Subtitle fetch failure becomes permanent | POL-04-01 | Visible retry recovers the same subtitle URL without restarting media |
| P2 | Optional speech installation has no product handoff | POL-07-02, POL-12-01 | Player points to host setup; host can start a bounded installation and see prerequisite, progress, failure and retry |
| P2 | Windows tray executable opens a console | POL-09-01 | Release PE subsystem is GUI; debug behavior remains available |
| P2 | Timeline/volume focus and value semantics are incomplete | POL-10-01, POL-10-02 | Visible keyboard outline and readable media-time/volume values |
| P3 | Waiting page reloads repeatedly | POL-08-02 | Poll status with bounded requests; navigate only when content becomes active |
| P2 | Paused controls disappear | Lead runtime observation | Controls remain visible while paused, ended or failed |

The empty hierarchy review is preserved, not treated as missing work. Baseline
Council ratings are 2 with medium confidence across the twelve dimensions;
these are not averaged into a release score.

## Cognitive profile and preservation

Memory and Decision: controlled. Search, Integration, Uncertainty and Recovery:
friction. All six are low-confidence heuristic assessments. No human workload,
completion-time or reduced-cognitive-load claim is supported.

Preserve the stable viewer URL, saved setup input, explicit expired-source
instructions, differentiated tray actions, dark/mint identity, LAN/host access
boundaries, subtitle text, bounded speech corrections and manual timing.

## Execution and verification status

Audit complete; implementation authorized by the user's full-polish request.
Follow `../product/release-polish-plan.md`. Baseline: 89 Node tests and one Rust
test pass; prior speech baseline has 10 passing tests. Candidate verification
and residual gaps will be recorded here after implementation. Windows native
interaction, clean-machine installation, Linux runtime and human usability
measurement remain unverified; none is silently treated as a pass.
