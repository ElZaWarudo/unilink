import assert from "node:assert/strict";
import test from "node:test";
import { SpeechSetup } from "../src/speech-setup.js";

const paths = { python: "/test/speech/venv/bin/python", model: "/test/speech/model" };
test('close awaits aborted installer and retired readiness cleanup exactly once', async () => {
  let finishProbe, finishInstall, probeEntered, installEntered;
  const probing = new Promise(resolve => { probeEntered = resolve; });
  const installing = new Promise(resolve => { installEntered = resolve; });
  let calls = 0;
  const setup = new SpeechSetup({ paths, available: async () => true, run: async (_command, _args, signal) => {
    if (++calls === 1) {
      probeEntered();
      await new Promise(resolve => { finishProbe = resolve; });
    } else {
      installEntered();
      await new Promise(resolve => { finishInstall = resolve; });
    }
    signal.throwIfAborted();
  } });
  const status = setup.status();
  await probing;
  await setup.setBackend('vulkan');
  setup.start();
  await installing;
  const closing = setup.close();
  assert.equal(setup.close(), closing);
  let closed = false;
  Promise.resolve(closing).then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  const waitedForInstall = !closed;
  finishInstall();
  await new Promise(resolve => setImmediate(resolve));
  const waitedForProbe = !closed;
  finishProbe();
  await Promise.all([closing, status]);
  assert.equal(waitedForInstall, true);
  assert.equal(waitedForProbe, true);
  assert.equal(setup.start().busy, false);
});
test('selecting Vulkan installs native assets while preserving the ready CPU environment', async () => {
  const calls = [];
  const setup = new SpeechSetup({ paths, available: async () => true,
    run: async (_command, args) => calls.push(args),
    nativeAvailable: async () => false,
    installNativeImpl: async (selected, signal) => {
      assert.equal(selected.backend, 'vulkan');
      assert.equal(signal.aborted, false);
      calls.push('native');
    } });
  assert.equal((await setup.status()).state, 'ready');
  await setup.setBackend('vulkan');
  assert.equal((await setup.status()).state, 'idle');
  setup.start();
  await setup.task;
  assert.equal((await setup.status()).state, 'ready');
  assert.equal((await setup.status()).backend, 'vulkan');
  assert.equal(calls.filter(entry => entry === 'native').length, 1);
  assert.equal(calls.some(entry => Array.isArray(entry) && entry.includes('pip')), false);
  setup.close();
});

test('backend cannot change during an active installer', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const setup = new SpeechSetup({ paths: { ...paths, backend: 'vulkan' }, available: async () => true,
    run: async () => {}, installNativeImpl: async (_paths, signal) => {
      entered();
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
    } });
  setup.start();
  await started;
  await assert.rejects(setup.setBackend('cpu'), /busy/);
  assert.equal(setup.paths.backend, 'vulkan');
  setup.close();
  await setup.task;
});

test("speech setup deduplicates requests, runs fixed stages and verifies completion", async () => {
  const calls = [];
  let available = false;
  const setup = new SpeechSetup({ paths, makeDirectory: async () => {}, available: async () => available,
    run: async (command, args) => { calls.push([command, args]); if (calls.length === 4) available = true; } });
  assert.equal(setup.start().busy, true);
  setup.start();
  await setup.task;
  assert.equal(calls.length, 5);
  assert.equal(calls[2][1].includes("faster-whisper==1.2.1"), true);
  assert.equal((await setup.status()).state, "ready");
  setup.start();
  await setup.task;
  assert.equal(calls.length, 6);
});

test("existing files with broken dependencies are repaired before readiness", async () => {
  let repaired = false; let probes = 0;
  const setup = new SpeechSetup({ paths, makeDirectory: async () => {}, available: async () => true,
    run: async (_command, args) => {
      if (args.includes("pip")) repaired = true;
      if (args[1]?.includes("WhisperModel")) { probes++; if (!repaired) throw Error("missing package"); }
    } });
  assert.equal((await setup.status()).state, "idle");
  setup.start(); await setup.task;
  assert.equal(repaired, true); assert.equal(probes, 3);
  assert.equal((await setup.status()).state, "ready");
});

test("missing Python produces an actionable error and can be retried", async () => {
  const setup = new SpeechSetup({ paths, available: async () => false,
    run: async () => { throw new Error("private filesystem details"); } });
  setup.start();
  await setup.task;
  const result = await setup.status();
  assert.equal(result.state, "error");
  assert.match(result.message, /Python 3\.10/);
  assert.doesNotMatch(result.message, /private/);
  assert.equal(setup.start().busy, true);
  await setup.task;
});

test("closing aborts the owned installation and prevents restart", async () => {
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const setup = new SpeechSetup({ paths, available: async () => false, run: async (_command, _args, signal) => {
    started();
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  } });
  setup.start();
  await entered;
  setup.close();
  await setup.task;
  assert.equal((await setup.status()).state, "error");
  assert.equal(setup.start().busy, false);
});

test("installation deadline aborts a stalled command and permits retry", async () => {
  let aborted = false;
  const setup = new SpeechSetup({ paths, timeoutMs: 10, available: async () => false,
    run: async (_command, _args, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(new Error("timeout")); }, { once: true });
    }) });
  setup.start();
  await new Promise(resolve => setTimeout(resolve, 30));
  await setup.task;
  assert.equal(aborted, true);
  assert.equal((await setup.status()).state, "error");
  setup.close();
});
