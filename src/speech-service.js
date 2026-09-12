import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// One private stdio worker per Unilink server, never a network-facing daemon.
export class SpeechService {
  constructor({ paths, spawnImpl = spawn, execFileImpl = execFile, platform = process.platform,
    cancelGraceMs = 10000, stopTimeoutMs = 5000 } = {}) {
    this.paths = paths;
    this.spawn = spawnImpl;
    this.cancelGraceMs = cancelGraceMs;
    this.execFile = execFileImpl;
    this.platform = platform;
    this.stopTimeoutMs = stopTimeoutMs;
    this.pending = new Map();
    this.worker = null;
    this.opening = null;
    this.closed = false;
  }

  async ensureWorker() {
    if (this.closed) throw new Error('speech service closed');
    if (this.worker?.stopping) {
      if (this.worker.stopError) throw this.worker.stopError;
      await (this.worker.stopPromise || this.worker.done);
    }
    if (this.closed) throw new Error('speech service closed');
    if (this.worker) return this.worker;
    if (!this.opening) this.opening = this.openWorker().finally(() => { this.opening = null; });
    return this.opening;
  }

  async openWorker() {
    const directory = await mkdtemp(join(tmpdir(), 'unilink-speech-service-'));
    try {
      for (const name of ['worker.py', 'alignment.py']) {
        await writeFile(join(directory, name), await readFile(new URL(`./speech/${name}`, import.meta.url)));
      }
      if (this.closed) throw new Error('speech service closed');
      const child = this.spawn(this.paths.python, ['-B', join(directory, 'worker.py'), '--serve'], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: this.platform !== 'win32',
        env: { ...process.env, OMP_WAIT_POLICY: 'PASSIVE', OMP_NUM_THREADS: '1', PYTHONIOENCODING: 'utf-8' },
      });
      const worker = { child, directory, stopping: false };
      worker.done = new Promise(resolveDone => {
        child.once('close', async () => {
          worker.exited = true;
          worker.stopping = true;
          for (const [id, job] of this.pending) {
            if (job.worker === worker) this.finish(id, new Error('speech worker stopped'));
          }
          await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
          if (this.worker === worker) this.worker = null;
          resolveDone();
        });
      });
      this.worker = worker;
      let buffer = '';
      child.stdout.on('data', chunk => {
        buffer += chunk.toString('utf8');
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (Buffer.byteLength(line) > 32768) { this.stop(worker); return; }
          try {
            const message = JSON.parse(line);
            const job = this.pending.get(message.id);
            if (!job || job.worker !== worker) continue;
            if (message.type === 'progress') {
              if (!job.signal.aborted) job.onProgress(message.stage);
            } else if (message.type === 'result') {
              this.finish(message.id, job.signal.aborted ? new Error('cancelled') : null, message);
            } else this.stop(worker);
          } catch { this.stop(worker); return; }
        }
        if (Buffer.byteLength(buffer) > 32768) this.stop(worker);
      });
      child.stderr.resume();
      child.stdin.on('error', () => this.stop(worker));
      child.once('error', () => this.stop(worker));
      return worker;
    } catch (error) {
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
      throw error;
    }
  }

  finish(id, error, result) {
    const job = this.pending.get(id);
    if (!job) return;
    this.pending.delete(id);
    clearTimeout(job.cancelTimer);
    job.signal.removeEventListener('abort', job.abort);
    if (error) job.reject(error); else job.resolve(result);
  }

  stop(worker) {
    if (worker.exited) return worker.done;
    if (worker.stopPromise) return worker.stopPromise;
    worker.stopping = true;
    worker.stopError = null;
    worker.stopPromise = Promise.resolve().then(() => new Promise((resolveStop, rejectStop) => {
      const child = worker.child;
      let fallbackUsed = false;
      const fallback = () => {
        if (worker.exited || fallbackUsed) return;
        // A parent-only Windows kill can orphan ffmpeg; retain the tree for an explicit retry.
        if (this.platform === 'win32' && child.pid) return;
        fallbackUsed = true;
        try { child.kill('SIGKILL'); } catch { /* The deadline reports an unconfirmed exit. */ }
      };
      const fallbackTimer = setTimeout(fallback, this.stopTimeoutMs / 2);
      const deadline = setTimeout(() => {
        clearTimeout(fallbackTimer);
        rejectStop(new Error('speech worker termination unconfirmed; retry close'));
      }, this.stopTimeoutMs);
      worker.done.then(resolveStop, rejectStop);
      const cleanup = () => { clearTimeout(fallbackTimer); clearTimeout(deadline); };
      worker.done.then(cleanup, cleanup);
      if (child.pid && this.platform === 'win32') {
        try {
          this.execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true, timeout: Math.max(1, this.stopTimeoutMs / 2),
          }, error => { if (error) fallback(); });
        } catch { fallback(); }
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { fallback(); }
      } else fallback();
    })).catch(error => {
      worker.stopError = error;
      throw error;
    }).finally(() => { worker.stopPromise = null; });
    // Protocol/error/abort listeners cannot await stop; explicit close still receives failures.
    worker.stopPromise.catch(() => {});
    return worker.stopPromise;
  }

  async run(input, signal, onProgress = () => {}) {
    signal.throwIfAborted();
    const worker = await this.ensureWorker();
    signal.throwIfAborted();
    const directory = await mkdtemp(join(worker.directory, 'job-'));
    try {
      const subtitlePath = join(directory, 'source.vtt');
      await writeFile(subtitlePath, input.subtitles, 'utf8');
      signal.throwIfAborted();
      if (this.closed || worker.stopping) throw new Error('speech worker stopped');
      if (this.pending.size >= 2) return { state: 'busy' };
      const id = randomUUID();
      const message = JSON.stringify({ type: 'align', id, input: {
        mediaUrl: input.mediaUrl, subtitlePath, audioIndex: input.audioIndex,
        start: input.start, duration: input.duration, ffmpeg: this.paths.ffmpeg,
        ffprobe: this.paths.ffprobe, modelPath: resolve(this.paths.model),
      } }) + '\n';
      if (Buffer.byteLength(message) > 32768) throw new Error('speech request too large');
      return await new Promise((resolveJob, reject) => {
        const job = { worker, signal, onProgress, resolve: resolveJob, reject };
        job.abort = () => {
          worker.child.stdin.write(JSON.stringify({ type: 'cancel', id }) + '\n');
          job.cancelTimer = setTimeout(() => this.stop(worker), this.cancelGraceMs);
        };
        this.pending.set(id, job);
        signal.addEventListener('abort', job.abort, { once: true });
        worker.child.stdin.write(message);
      });
    } finally {
      // Only this request's mkdtemp directory, after acknowledgment or process exit.
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  async close() {
    this.closed = true;
    if (this.opening) await this.opening.catch(() => {});
    if (this.worker) await this.stop(this.worker);
  }
}
