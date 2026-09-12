import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('shader splitting preserves every declaration byte in order', async t => {
  const root = await mkdtemp(join(tmpdir(), 'unilink-shader-split-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const header = '#include "ggml-vulkan-shaders.hpp"\r\n\r\n';
  const body = Array.from({ length: 40 }, (_, index) =>
    `const uint64_t shader_${index}_len = 4;\r\nconst unsigned char shader_${index}_data[4] = {0x1,0x2,0x3,0x4};\r\n\r\n`).join('');
  const source = join(root, 'table.cpp');
  await writeFile(source, header + body);
  const script = fileURLToPath(new URL('../src/speech/native/split-shaders.mjs', import.meta.url));
  const split = () => execute(process.execPath, [script, source, join(root, 'parts')], { windowsHide: true, timeout: 30000 });
  await split();
  const parts = await Promise.all(Array.from({ length: 16 }, (_, index) => readFile(join(root, 'parts', `mul-mm-${index}.cpp`), 'utf8')));
  assert.equal(parts.map(part => {
    assert.equal(part.startsWith(header), true);
    return part.slice(header.length);
  }).join(''), body);
  await writeFile(source, 'unexpected generated format');
  await assert.rejects(split(), /Unexpected generated shader table/);
});

test('the real packaging gate rejects stale, modified, missing and unexpected native assets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'unilink-build-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = await readFile(new URL('../scripts/build-speech-native.js', import.meta.url));
  const native = join(root, 'src', 'speech', 'native');
  const bundle = join(root, 'build', 'speech-native');
  await Promise.all([mkdir(native, { recursive: true }), mkdir(bundle, { recursive: true }), mkdir(join(root, 'scripts'))]);
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'scripts', 'build-speech-native.js'), script);
  const sourceHash = createHash('sha256');
  for (const name of ['CMakeLists.txt', 'bridge.cpp', 'split-shaders.mjs']) {
    const bytes = await readFile(new URL(`../src/speech/native/${name}`, import.meta.url));
    await writeFile(join(native, name), bytes);
    sourceHash.update(name).update(bytes);
  }
  sourceHash.update(script);
  const files = [
    { name: 'unilink-whisper.exe', bytes: 'test executable bytes' },
    { name: 'THIRD-PARTY-NOTICES.txt', bytes: 'test notices' },
  ];
  for (const file of files) await writeFile(join(bundle, file.name), file.bytes);
  const manifest = { version: 1, backend: 'vulkan', whisperVersion: '1.9.4', sourceHash: sourceHash.digest('hex'),
    files: files.map(file => ({ name: file.name, sha256: digest(file.bytes) })) };
  await writeFile(join(bundle, 'manifest.json'), JSON.stringify(manifest));
  const verify = () => execute(process.execPath, [join(root, 'scripts', 'build-speech-native.js'), '--verify-only'],
    { windowsHide: true, timeout: 30000 });
  assert.match((await verify()).stdout, /verified/);
  await assert.rejects(execute(process.execPath, [join(root, 'scripts', 'build-speech-native.js'), '--stage-only'],
    { windowsHide: true, timeout: 30000 }), /Usage:/);

  await writeFile(join(bundle, 'unilink-whisper.exe'), 'modified');
  await assert.rejects(verify(), /failed verification/);
  await writeFile(join(bundle, 'unilink-whisper.exe'), files[0].bytes);
  await writeFile(join(bundle, 'unlisted.dll'), 'unexpected');
  await assert.rejects(verify(), /unlisted or duplicate/);
  await rm(join(bundle, 'unlisted.dll'));
  await rm(join(bundle, 'THIRD-PARTY-NOTICES.txt'));
  await assert.rejects(verify(), /unlisted or duplicate/);
  await writeFile(join(bundle, 'THIRD-PARTY-NOTICES.txt'), files[1].bytes);
  await writeFile(join(native, 'bridge.cpp'), 'changed native source');
  await assert.rejects(verify(), /stale/);
});
