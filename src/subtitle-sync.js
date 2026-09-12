import { spawn, execFile } from "node:child_process";
import { access, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, delimiter } from "node:path";
import { randomUUID } from "node:crypto";
import { SpeechService } from "./speech-service.js";
import { SPEECH_BACKENDS } from "./config.js";

export function speechPaths(env = process.env) {
  const home = resolve(env.UNILINK_SUBTITLE_SYNC_HOME || join(homedir(), ".unilink", "subtitle-sync"));
  const windows = process.platform === "win32";
  const stremio = env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Stremio");
  return {
    python: join(home, "venv", windows ? "Scripts/python.exe" : "bin/python"),
    model: join(home, "model"),
    backend: "cpu",
    nativeExecutable: join(home, "native", windows ? "unilink-whisper.exe" : "unilink-whisper"),
    nativeModel: join(home, "ggml-base.en.bin"),
    ffmpeg: env.UNILINK_FFMPEG || (windows && stremio ? join(stremio, "ffmpeg.exe") : "ffmpeg"),
    ffprobe: env.UNILINK_FFPROBE || (windows && stremio ? join(stremio, "ffprobe.exe") : "ffprobe"),
  };
}

async function resolveExecutable(path) {
  if (isAbsolute(path)) return access(path).then(() => path, () => null);
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    const candidate = resolve(directory, path);
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  return null;
}

export async function speechAvailable(paths = speechPaths()) {
  const checks = await Promise.all([
    resolveExecutable(paths.python), resolveExecutable(paths.ffmpeg), resolveExecutable(paths.ffprobe),
    ...["model.bin", "config.json", "tokenizer.json", "vocabulary.txt"].map(name =>
      access(join(paths.model, name)).then(() => true, () => false)),
  ]);
  return checks.every(Boolean);
}

function runProcess(python, script, input, signal) {
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) return reject(new Error("cancelled"));
    const child = spawn(python, ["-B", script], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: { ...process.env, OMP_WAIT_POLICY: "PASSIVE", PYTHONIOENCODING: "utf-8" },
    });
    let output = "";
    let oversized = false;
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      } else { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }
    };
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", chunk => {
      if (oversized) return;
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > 32768) { oversized = true; stop(); }
    });
    // Drain diagnostics without exposing media, transcript text, or local paths.
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", error => { signal.removeEventListener("abort", stop); reject(error); });
    child.once("close", code => {
      signal.removeEventListener("abort", stop);
      if (signal.aborted || oversized || code !== 0) return reject(new Error("speech worker failed"));
      try { resolvePromise(JSON.parse(output)); } catch { reject(new Error("invalid speech result")); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export async function runSpeech(input, signal, paths = speechPaths()) {
  const directory = await mkdtemp(join(tmpdir(), "unilink-speech-"));
  try {
    for (const name of ["worker.py", "alignment.py", "backends.py"]) {
      await writeFile(join(directory, name), await readFile(new URL(`./speech/${name}`, import.meta.url)));
    }
    const subtitlePath = join(directory, "source.vtt");
    await writeFile(subtitlePath, input.subtitles, "utf8");
    return await runProcess(paths.python, join(directory, "worker.py"), {
      mediaUrl: input.mediaUrl, subtitlePath, audioIndex: input.audioIndex,
      start: input.start, duration: input.duration,
      backend: paths.backend || "cpu", nativeExecutable: paths.nativeExecutable, nativeModel: paths.nativeModel,
      ffmpeg: await resolveExecutable(paths.ffmpeg), ffprobe: await resolveExecutable(paths.ffprobe), modelPath: resolve(paths.model),
    }, signal);
  } finally {
    // mkdtemp owns this exact directory; never delete outside the system temp root.
    if (dirname(resolve(directory)) === resolve(tmpdir()) && directory.includes("unilink-speech-")) {
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

export function validCorrection(result, window) {
  return result && ["start", "end", "offset", "anchors", "residual"].every(k => Number.isFinite(result[k])) &&
    result.start >= Math.max(0, window.start - 30) && result.end <= window.start + window.duration + 30 &&
    result.end > result.start && Math.abs(result.offset) <= 30 && Number.isInteger(result.anchors) &&
    result.anchors >= 6 && result.residual >= 0 && result.residual <= .6;
}

export class SubtitleSync {
  constructor({ run, available, paths = speechPaths(), timeoutMs = 180000, now = Date.now, maxConcurrent = 2 } = {}) {
    this.paths = { ...paths };
    this.service = run ? null : new SpeechService({ paths: this.paths });
    this.run = run || (async (input, signal, progress) => {
      const paths = this.service.paths;
      paths.ffmpeg = await resolveExecutable(paths.ffmpeg);
      paths.ffprobe = await resolveExecutable(paths.ffprobe);
      return this.service.run(input, signal, progress);
    });
    this.available = available || (() => speechAvailable(this.paths));
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.jobs = new Map();
    this.running = new Set();
    this.maxConcurrent = Math.max(1, Math.min(2, maxConcurrent));
    this.closed = false;
    this.releasing = null;
  }

  get active() { return this.running.values().next().value || null; }

  view(job) {
    if (!job) return { state: "stale" };
    return { state: job.state, jobId: job.id, ...(job.result ? { result: job.result } : {}),
      ...(job.state === "working" ? { stage: job.stage, elapsedMs: Math.max(0, this.now() - job.created) } : {}),
      ...(job.reason ? { reason: job.reason } : {}) };
  }

  get(id) {
    const job = this.jobs.get(id);
    if (job && !job.isCurrent()) { this.cancel(id, "stale"); return { state: "stale" }; }
    return this.view(job);
  }

  cancel(id, state = "cancelled") {
    const job = this.jobs.get(id);
    if (job?.state === "working") {
      job.state = state;
      job.controller.abort();
    }
    return this.view(job);
  }

  start({ key, isCurrent, prepare, window, requestId }) {
    if (this.closed) return { state: "unavailable" };
    if (this.releasing || this.changingBackend) return { state: "busy" };
    if (!isCurrent()) return { state: "stale" };
    for (const [id, job] of this.jobs) {
      if (!job.isCurrent() || this.now() - job.created > 600000) {
        this.cancel(id, "stale");
        if (!this.running.has(job)) this.jobs.delete(id);
      } else if (job.key === key && ["working", "ready", "insufficient"].includes(job.state) &&
          (job.state !== "working" || job.requestId === requestId)) return this.view(job);
    }
    if (this.running.size >= this.maxConcurrent) return { state: "busy" };
    while (this.jobs.size >= 32) {
      const oldest = [...this.jobs].find(([, job]) => !this.running.has(job));
      if (!oldest) return { state: "busy" };
      this.jobs.delete(oldest[0]);
    }
    const job = { id: randomUUID(), key, requestId, isCurrent, state: "working", stage: "preparing", created: this.now(), controller: new AbortController() };
    this.jobs.set(job.id, job);
    this.running.add(job);
    const timer = setTimeout(() => { this.cancel(job.id, "error"); job.reason = "timeout"; }, this.timeoutMs);
    const staleTimer = setInterval(() => { if (!isCurrent()) this.cancel(job.id, "stale"); }, 1000);
    Promise.resolve().then(async () => {
      const input = await prepare(job.controller.signal);
      if (job.controller.signal.aborted || !isCurrent()) return;
      const outcome = await this.run({ ...input, ...window }, job.controller.signal, stage => {
        if (!job.controller.signal.aborted && ["extracting", "loading_model", "queued", "recognizing", "matching"].includes(stage)) job.stage = stage;
      });
      if (job.controller.signal.aborted || !isCurrent()) return;
      if (SPEECH_BACKENDS.includes(outcome.metrics?.backend)) {
        this.runtime = { backend: outcome.metrics.backend,
          fallbackReason: ["cuda_unavailable", "cuda_failed", "vulkan_unavailable", "vulkan_failed"].includes(outcome.metrics.fallbackReason)
            ? outcome.metrics.fallbackReason : null };
      }
      if (outcome.state === "ready" && validCorrection(outcome.result, window)) {
        job.state = "ready";
        job.result = outcome.result;
      } else if (outcome.state === "insufficient") job.state = "insufficient";
      else { job.state = "error"; job.reason = "recognition_failed"; }
    }).catch(() => {
      if (!job.controller.signal.aborted) { job.state = "error"; job.reason = "recognition_failed"; }
    }).finally(() => {
      if (!isCurrent()) job.state = "stale";
      clearTimeout(timer);
      clearInterval(staleTimer);
      this.running.delete(job);
    });
    return this.view(job);
  }

  release() {
    if (!this.releasing) this.releasing = (async () => {
      for (const job of this.running) this.cancel(job.id);
      if (this.service) {
        await this.service.close();
        if (!this.closed) this.service = new SpeechService({ paths: this.paths });
      }
    })().finally(() => { this.releasing = null; });
    return this.releasing;
  }

  close() { this.closed = true; return this.release(); }

  backendStatus() { return this.runtime ? { ...this.runtime } : null; }

  async setBackend(backend) {
    if (!SPEECH_BACKENDS.includes(backend)) throw new Error("invalid speech backend");
    if (backend === (this.paths.backend || "cpu")) return;
    this.changingBackend = true;
    try {
      await this.release();
      this.paths.backend = backend;
      this.runtime = null;
      this.jobs.clear();
    } finally { this.changingBackend = false; }
  }
}
