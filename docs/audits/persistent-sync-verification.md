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
