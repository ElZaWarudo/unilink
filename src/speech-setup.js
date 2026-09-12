import { spawn, execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { speechAvailable, speechPaths } from "./subtitle-sync.js";

function runSetupProcess(command, args, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("cancelled"));
    const child = spawn(command, args, { windowsHide: true, stdio: "ignore", detached: process.platform !== "win32" });
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
    };
    signal.addEventListener("abort", stop, { once: true });
    child.once("error", error => { signal.removeEventListener("abort", stop); reject(error); });
    child.once("close", code => {
      signal.removeEventListener("abort", stop);
      if (signal.aborted || code !== 0) reject(new Error("setup failed"));
      else resolve();
    });
  });
}

const MESSAGES = {
  checking: "Comprobando Python 3.10 o posterior…",
  environment: "Preparando el entorno local…",
  dependencies: "Instalando el motor de voz. Puede tardar varios minutos…",
  model: "Descargando el modelo de inglés. Puede tardar varios minutos…",
  verifying: "Comprobando la instalación…",
};

function failureMessage(state, aborted) {
  if (aborted) return "La instalación se detuvo. Puedes volver a intentarlo.";
  if (state === "checking") return "No se encontró Python 3.10 o posterior. Instálalo en el PC y vuelve a intentarlo.";
  if (state === "verifying") return "No se pudo verificar el motor de voz. Comprueba que Stremio esté instalado y vuelve a intentar la instalación.";
  return "No se pudo completar la instalación. Comprueba la conexión a Internet y el espacio libre; vuelve a intentarlo.";
}

export class SpeechSetup {
  constructor({ paths = speechPaths(), python = process.env.UNILINK_SETUP_PYTHON || (process.platform === "win32" ? "python" : "python3"),
    run = runSetupProcess, available = () => speechAvailable(paths), makeDirectory = mkdir, timeoutMs = 20 * 60_000 } = {}) {
    Object.assign(this, { paths, python, run, available, makeDirectory, timeoutMs });
    this.result = { state: "idle", message: "Instala el motor local para sincronizar audio y subtítulos en inglés." };
    this.task = null;
    this.closed = false;
    this.probeController = new AbortController();
  }

  async status() {
    if (!this.closed && !this.task && this.result.state === "idle") {
      this.readiness ??= (async () => {
        if (!await this.available()) return false;
        try { await this.probe(this.probeController.signal); return true; } catch { return false; }
      })();
      const ready = await this.readiness;
      if (ready && !this.closed && !this.task && this.result.state === "idle") {
        this.result = { state: "ready", message: "Motor de inglés disponible. Activa Auto-sync inglés en el reproductor." };
      }
    }
    return { ...this.result, busy: Boolean(this.task) };
  }

  start() {
    if (this.task || this.closed) return { ...this.result, busy: Boolean(this.task) };
    this.probeController.abort();
    this.controller = new AbortController();
    this.result = { state: "checking", message: MESSAGES.checking };
    const timer = setTimeout(() => this.controller.abort(), this.timeoutMs);
    timer.unref?.();
    this.task = this.install(this.controller.signal).catch(() => {
      this.result = { state: "error", message: failureMessage(this.result.state, this.controller.signal.aborted) };
    }).finally(() => { clearTimeout(timer); this.task = null; });
    return { ...this.result, busy: true };
  }

  async install(signal) {
    if (await this.available()) {
      try {
        await this.probe(signal);
        signal.throwIfAborted();
        this.result = { state: "ready", message: "Motor de inglés disponible. Activa Auto-sync inglés en el reproductor." };
        return;
      } catch { signal.throwIfAborted(); /* Repair an incomplete existing environment. */ }
    }
    const step = async (state, command, args) => {
      signal.throwIfAborted();
      this.result = { state, message: MESSAGES[state] };
      await this.run(command, args, signal);
      signal.throwIfAborted();
    };
    await step("checking", this.python, ["-c", "import sys; assert sys.version_info >= (3,10)"]);
    const venv = dirname(dirname(this.paths.python));
    await this.makeDirectory(dirname(venv), { recursive: true });
    await step("environment", this.python, ["-m", "venv", venv]);
    await step("dependencies", this.paths.python, ["-m", "pip", "install", "faster-whisper==1.2.1", "ctranslate2==4.8.2"]);
    await step("model", this.paths.python, ["-c", "from huggingface_hub import snapshot_download; import sys; snapshot_download('Systran/faster-whisper-base.en', local_dir=sys.argv[1], allow_patterns=['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.*'])", this.paths.model]);
    this.result = { state: "verifying", message: MESSAGES.verifying };
    if (!await this.available()) throw new Error("unavailable");
    await this.probe(signal);
    signal.throwIfAborted();
    this.result = { state: "ready", message: "Motor de inglés instalado. Activa Auto-sync inglés en el reproductor." };
  }

  async probe(signal) {
    const controller = new AbortController();
    // Cold model loading can take over a minute on a busy Windows host.
    const timeout = setTimeout(() => controller.abort(), 120000);
    timeout.unref?.();
    const boundedSignal = AbortSignal.any([signal, controller.signal]);
    try {
      boundedSignal.throwIfAborted();
      await this.run(this.paths.python, ["-c", "from importlib.metadata import version; from faster_whisper import WhisperModel; import sys; assert version('faster-whisper') == '1.2.1'; assert version('ctranslate2') == '4.8.2'; WhisperModel(sys.argv[1], device='cpu', compute_type='int8', local_files_only=True)", this.paths.model], boundedSignal);
      boundedSignal.throwIfAborted();
    } finally { clearTimeout(timeout); }
  }

  close() {
    this.closed = true;
    this.probeController.abort();
    this.controller?.abort();
  }
}
