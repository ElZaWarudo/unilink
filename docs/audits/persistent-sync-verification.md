# Persistent speech service and playback recovery

Implementation baseline: `75e15a8060a695247f511d4cae2dd74900afeda4`.

The speech subprocess now lives for the Unilink server session. It loads the English model once, prepares at most two audio samples concurrently, and serializes recognition through one model with one CPU thread. This avoids duplicate model memory and limits competition with video transcoding. Closing Unilink or repairing the speech installation releases the worker. Cancellation is cooperative; a worker that fails to acknowledge cancellation is terminated after a ten-second grace period and recreated on demand.

Review identified and corrected two shutdown failures: the command-line server now awaits HTTP closure and resource cleanup before exiting; termination attempts have a five-second deadline and retain worker ownership when exit cannot be confirmed. Explicit close can retry a failed attempt. Model repair waits for release, and a concurrent close prevents service recreation. Windows desktop shutdown already terminates the owned process tree; forced termination does not provide the same temporary-file cleanup guarantee as graceful server shutdown.

If Windows tree termination fails, the service retains the parent for an explicit retry instead of killing only that parent and potentially orphaning descendants. The termination deadline reports failure rather than admitting a replacement worker.

Progress distinguishes extraction, model loading, waiting for recognition, recognition and matching. Existing anchor-count and residual checks still gate subtitle corrections.

## Runtime evidence

Four real requests used the same process and the same 60-second English audio sample. Cold completion took 39.2 seconds and warm completion 31.8 seconds. Concurrent requests completed in 29.3 and 56.7 seconds: both prepared audio in under a second, then recognition ran sequentially. All four returned the identical +1.458-second correction with 15 anchors and a 0.116-second residual. These are single-machine measurements, not general performance guarantees or comparisons against earlier 120-second samples.

A cancellation during recognition completed in 11.8 seconds, including worker termination and Windows cleanup; pending requests returned to zero. Real diagnostics exposed a native dependency import stall when loading NumPy on the model thread alongside subprocess activity. Importing faster-whisper on the main worker thread before starting thread pools removed that stall; model construction still overlaps audio preparation.

A normal launcher smoke returned the same correction in 49.3 seconds while packaging competed for CPU. An isolated Windows process-tree test used a real Python worker and sleeping child that ignored cancellation: the production termination path removed both processes and the owned temporary directory, with zero pending requests.

## TV playback

The supplied photo exposed error CSS that hid the video element and collapsed the player while audio could continue. Error styling now preserves the video surface and fullscreen height. A native terminal media error pauses playback and identifies connection, decoding or format failure. HLS recovery requires new rendered frames where browser frame counters are available, instead of accepting audio-driven time advancement alone.

A real browser fixture with the error class confirmed the video remains `display: block`, with both video and surface 420 pixels high. The TV's original media-error trigger is not established. The observed source was already transcoded to H.264; no speculative codec or Stremio setting change was applied.

## Validation and rollout

JavaScript tests cover shared-worker reuse, out-of-order request correlation, cancellation, forced reset, shutdown, admission limits, progress and playback recovery. Python tests cover model reuse, background loading, cancellation while queued, retry after failed loading and stdio protocol handling.

Final checks passed: 133 JavaScript tests, 15 Python tests, syntax checks and the real Windows process-tree smoke. Nine independent review lenses and a separate repair validator completed with no actionable findings remaining; the receipt is in `persistent-sync-code-review.json`. Additional frame-counter edge-case tests and a Python segment-failure lock-release test remain optional coverage improvements, not observed failures.

After installing this build, verify two English alignment requests reuse the worker, cancellation settles, and closing Unilink releases it. On the TV, verify error/retry preserves the video surface and picture recovery; retain the displayed error category if decoding still fails. Roll back if the new worker leaves persistent children after shutdown or causes repeatable playback regression. The running installed application is not replaced by these source changes.

## Follow-up: decoder recovery and saved manual timing

The next TV report showed native decoding error 3 at 2:28 while recognition was running. The live player status also reported a saved manual delay of -2 seconds. The preceding implementation deliberately added this manual delay to automatic corrections; the user explicitly chose to have automatic timing replace the existing adjustment instead.

The served player asset matched the preceding reviewed commit `1a67b75` after newline normalization, ruling out an older player asset as the cause of this report.

Each player now captures the manual baseline when autosync is enabled and subtracts it while auto remains enabled. Later manual changes fine-tune that automatic timing relatively. Disabling auto restores ordinary manual timing; this does not rewrite shared PC settings. A DOM integration test verifies the spoken cue is visible at its corrected time, a subsequent +1-second adjustment works, and disabling restores manual timing.

The installed hls.js 1.7.2 can reset MediaSource before notifying the application's error listener. The player previously paused on the native error but only tracked fatal HLS recovery. A library-managed nonfatal reset therefore lost play intent and never armed the frame-progress check: even successful playback left the error overlay active. An isolated reproduction confirmed that sequence using the real player and the library's documented event ordering.

Recovery now captures position, frame evidence and play intent before the reset, handles library-managed resets without duplicating them, and resumes after attachment only when requested. Deliberate pause and a Play request during attachment are covered. Repeated failure stops recovery until an explicit retry. Errors clear on video progress; browsers without frame counters retain the existing width/time fallback. Non-decoding native errors remain terminal.

The initial TV decoder fault is still unproven: these checks establish the application recovery defect, not the physical TCL decoder's failure mechanism. Actual TV playback after updating remains required. This follow-up does not claim to change speech-model accuracy or extend verified alignment beyond the matched sections.

Follow-up quality: simplification removed one redundant recovery flag; 136 JavaScript tests and syntax checks pass. Targeted independent review of the three fix-owned code/test files found no actionable regression and independently passed 30 player tests. HLS callbacks are simulated in those tests; real browser MediaSource/play-promise ordering and library resets without a preceding native error remain coverage limitations. Previous release commits and user attachments were excluded from this review. The fix remains local until explicitly published.

## Follow-up: live PC timing, compact controls and automatic retries

Players report the applied regional correction and their captured manual baseline through a token-protected, same-origin endpoint. Reports expire after 15 seconds, are ordered per player and never change saved settings. PC status derives the total correction and extra manual adjustment separately; the latest reporting player supplies the live view. The session page polls without replacing unsaved edits. Its extra-adjustment reset returns to the active automatic baseline, and normal manual controls return when automatic timing is off.

The TV overlay removes the PC configuration link, places a compact Auto-sync control beside CC, and reduces spacing while retaining remote/touch targets. Temporary recognition, capability and polling failures now retry with bounded timer backoff, including while paused. Existing verified corrections remain valid only within their matched regions. Turning auto off, changing context or closing the player cancels retries; stale source failures remain terminal for that context.

Browser verification used an isolated loopback fixture: +1.458 seconds displayed as +1,46 s, applying +0.05 changed the total to +1,51 s, and unsaved edits survived polling. Desktop/fullscreen and 390-pixel layouts retained visible controls without horizontal overflow. The fixture deliberately lacked Stremio media; it validates layout and settings flow, not TV decoding or real speech accuracy. PC console checks found no errors. Test fixtures and the installed service were stopped afterward.

Verification: 157 repository-owned JavaScript tests pass (`node --test test/*.test.js`), plus syntax checks. Upstream whisper.cpp source downloaded under ignored build directories has unrelated Node tests and is excluded from this command. Retry tests and the server timing contract were observed failing before implementation; UI behavior tests were added after implementation, with browser verification afterward. Simplification completed reuse, quality and efficiency passes, with one local-variable cleanup. Code review completed eight persona passes through one independent reviewer session and a separate finding validator because new agent threads were unavailable; it did not claim eight independent reviewers. Receipt: `20260913-live-autosync`. Its one P2 reporter-context finding was fixed and both sequential A→B→A and delayed-old-response regressions passed. The preparation/dirty-settings coverage gap was also closed. No known actionable findings remain.

## Follow-up: selectable Vulkan, CUDA and CPU speech engines

The PC now persists one of three choices: faster-whisper CPU, faster-whisper CUDA, or whisper.cpp Vulkan. CPU remains installed and is the default. CUDA keeps the existing faster-whisper route, using float16 with CUDA 12/cuDNN 9. Vulkan uses a private native JSON-lines process with a warm base.en context and DTW token timestamps. The adapter joins token pieces into words and adds the audio sample offset once. Phrase matching still rejects weak evidence; DTW timestamps do not establish phonetic ground truth.

GPU initialization or recognition failures fall back to CPU and report the actual engine separately from the saved preference. Cancellation cleans up the private native process without interpreting it as a GPU failure. Failed cleanup retains process ownership and prevents fallback until exit is confirmed. A failed constructor remains owned through its failed model future; shutdown keeps the Python parent available for the Node process-tree deadline. Backend initialization retries transient failures only after rollback, and setup shutdown awaits installation and retired readiness probes.

The Windows build pins whisper.cpp 1.9.4 and verifies downloaded source/tool archive hashes. A complete rebuild precedes bundle manifest creation; staging an arbitrary previous executable is unsupported. Packaging verifies source provenance, file inventory and runtime hashes. The generated 130 MB shader table is split at complete declarations into 16 compiler inputs without changing declaration bytes, avoiding the observed single-translation-unit memory exhaustion. A fresh Ninja dependency graph retained its generation rule, contained all 16 inputs and no cycles.

Measurements used the same local 60-second English dialogue WAV and subtitles on a Ryzen 5 5500U/Radeon integrated GPU, with private loopback fixtures and the installed Unilink service stopped:

| Engine | Cold total | Warm total | Correction | Phrase anchors | Residual |
| --- | ---: | ---: | ---: | ---: | ---: |
| faster-whisper CPU int8 | 34.697 s | 25.506 s | +1.458 s | 15 | 0.116 s |
| whisper.cpp Vulkan F16 | 57.763 s | 29.717 s | +1.6685 s | 12 | 0.076 s |

Both runs per engine reused the Python worker and repeated the same alignment result. GPU acceleration was confirmed on the Radeon device, but was slower on this sample, so no GPU speedup is claimed. The 0.2105-second difference between engines is not an accuracy improvement claim. A Q5_1 experiment retained 12 anchors and +1.6685 seconds but measured 30.353 seconds cold and 51.289 seconds warm; its close also reported an unconfirmed deadline before the owned processes disappeared. It was not adopted. Other work on the host limits conclusions from single-pair timing. No NVIDIA hardware was available; CUDA load/deferred-failure fallback and routing are covered with fixtures, not a hardware benchmark.

Verification: 177 JavaScript tests, 28 Python tests and syntax checks pass. Real native protocol fixtures cover warm reuse, cancellation during reload, malformed responses and owned-child cleanup. New cleanup and release-gate regressions failed before their fixes. The PC browser fixture verified Vulkan selection, persistence, explicit CPU fallback and clean console output. It did not exercise the physical TV decoder. Independent code review completed nine lenses with a separate finding validator (`20260913-vulkan-speech`); simplification completed three independent passes. Review findings covered build provenance, shutdown, initialization retry and native cleanup/cancellation. Root implemented the native/build follow-ups when fresh fix-agent dispatch hit the thread limit; independent validation remained separate.

The release stays local and does not replace the installed application. After installing, verify actual engine status, two successive English matches, cancellation and application shutdown on the intended host. Repeated orphan processes or playback regressions warrant returning to CPU and the previous installer. Physical TV decoding and episode-wide subtitle accuracy remain outside this sample's evidence.
