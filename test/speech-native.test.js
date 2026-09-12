import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { installNative, nativeInstalled } from '../src/speech-native.js';

const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'unilink-native-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sourcePath = join(home, 'bundle');
  await mkdir(sourcePath);
  const bytes = Buffer.from('test executable');
  const manifest = { version: 1, backend: 'vulkan', whisperVersion: '1.9.4',
    files: [{ name: 'unilink-whisper.exe', sha256: hash(bytes) }] };
  const saveManifest = () => writeFile(join(sourcePath, 'manifest.json'), JSON.stringify(manifest));
  await saveManifest();
  await writeFile(join(sourcePath, 'unilink-whisper.exe'), bytes);
  const paths = { nativeExecutable: join(home, 'installed', 'unilink-whisper.exe'),
    nativeModel: join(home, 'installed', 'ggml-base.en.bin') };
  const modelBytes = Buffer.from('test model');
  const model = { url: 'https://invalid.example/test-model', sha256: hash(modelBytes) };
  return { paths, manifest, saveManifest, sourcePath, bytes, modelBytes, model,
    options: { source: pathToFileURL(`${sourcePath}/`), model, fetchImpl: async () => new Response(modelBytes) } };
}

test('native setup validates bundled bytes before touching installed files', async t => {
  const f = await fixture(t);
  await mkdir(dirname(f.paths.nativeExecutable), { recursive: true });
  await writeFile(f.paths.nativeExecutable, 'existing executable');
  await writeFile(join(f.sourcePath, 'unilink-whisper.exe'), 'corrupt executable');
  let fetched = false;
  await assert.rejects(installNative(f.paths, new AbortController().signal, {
    ...f.options, fetchImpl: async () => { fetched = true; throw Error('unexpected'); },
  }), /Invalid bundled/);
  assert.equal(await readFile(f.paths.nativeExecutable, 'utf8'), 'existing executable');
  assert.equal(fetched, false);
});

test('native setup rejects unsafe manifests', async t => {
  const f = await fixture(t);
  for (const name of ['../outside.exe', 'nested/engine.dll', 'engine.ps1']) {
    f.manifest.files.push({ name, sha256: hash('irrelevant') });
    await f.saveManifest();
    await assert.rejects(installNative(f.paths, new AbortController().signal, f.options), /Invalid bundled/);
    f.manifest.files.pop();
  }
  await assert.rejects(access(f.paths.nativeExecutable));
});

test('native setup installs checked model and reuses it without another download', async t => {
  const f = await fixture(t);
  let downloads = 0;
  const options = { ...f.options, fetchImpl: async () => { downloads++; return new Response(f.modelBytes); } };
  assert.equal(await nativeInstalled(f.paths), false);
  await installNative(f.paths, new AbortController().signal, options);
  assert.equal(await nativeInstalled(f.paths), true);
  assert.deepEqual(await readFile(f.paths.nativeExecutable), f.bytes);
  assert.deepEqual(await readFile(f.paths.nativeModel), f.modelBytes);
  await installNative(f.paths, new AbortController().signal, options);
  assert.equal(downloads, 1);
  await assert.rejects(access(`${f.paths.nativeModel}.download`));
});

test('bad model digest preserves old model and removes partial download', async t => {
  const f = await fixture(t);
  await mkdir(dirname(f.paths.nativeExecutable), { recursive: true });
  await writeFile(f.paths.nativeModel, 'old model');
  await assert.rejects(installNative(f.paths, new AbortController().signal, {
    ...f.options, fetchImpl: async () => new Response('corrupt model'),
  }), /Invalid speech model download/);
  assert.equal(await readFile(f.paths.nativeModel, 'utf8'), 'old model');
  await assert.rejects(access(`${f.paths.nativeModel}.download`));
});

test('cancelling model download removes partial file and preserves old model', async t => {
  const f = await fixture(t);
  await mkdir(dirname(f.paths.nativeExecutable), { recursive: true });
  await writeFile(f.paths.nativeModel, 'old model');
  const controller = new AbortController();
  let cancelStream = false;
  const body = new ReadableStream({
    start(stream) { stream.enqueue(new Uint8Array([1, 2, 3])); },
    pull() { controller.abort(); },
    cancel() { cancelStream = true; },
  });
  await assert.rejects(installNative(f.paths, controller.signal, {
    ...f.options, fetchImpl: async () => new Response(body),
  }), { name: 'AbortError' });
  assert.equal(await readFile(f.paths.nativeModel, 'utf8'), 'old model');
  await assert.rejects(access(`${f.paths.nativeModel}.download`));
  assert.equal(cancelStream, true);
});
