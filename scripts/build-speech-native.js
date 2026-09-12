// Developer-only Windows build. Users receive this bundle through the installer.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, 'build', 'whisper-cpp-probe');
const output = join(root, 'build', 'speech-native');
const native = join(root, 'src', 'speech', 'native');
const archives = [
  ['source.tar.gz', 'https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.4.tar.gz', '57e280cee375ab02425b806ad5146b99f6eb9357e3c2b31357c8a6af2e2e44ae'],
  ['vulkan-headers.tar.gz', 'https://github.com/KhronosGroup/Vulkan-Headers/archive/refs/tags/v1.4.335.tar.gz', '8ee39bee575bdccc1ecacd0bdb26f181841de35d7409a3eca468c6b622daa2f1'],
  ['vulkan-hpp.tar.gz', 'https://github.com/KhronosGroup/Vulkan-Hpp/archive/refs/tags/v1.4.335.tar.gz', '618808b7e8f6e6cb765f7c50bd6e3710701e4c6d9583cdd38224bc538e8abb92'],
  ['spirv-headers.tar.gz', 'https://github.com/KhronosGroup/SPIRV-Headers/archive/refs/tags/vulkan-sdk-1.4.335.0.tar.gz', '1c47ca6342ebe86f57b46b8dbeb266fa655a1ca8e10d07e45370ff2d9c36312e'],
  ['shaderc.zip', 'https://storage.googleapis.com/shaderc/artifacts/prod/graphics_shader_compiler/shaderc/windows-vs2022-amd64-release/continuous/41/20260911-120529/install.zip', '51372e54b846d4c01e71deb85325fd90cc182f071abc810342ef45d9137fdc63'],
];
const licenses = [
  ['gcc-copying.txt', 'https://raw.githubusercontent.com/gcc-mirror/gcc/releases/gcc-13.2.0/COPYING3', '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903'],
  ['gcc-runtime.txt', 'https://raw.githubusercontent.com/gcc-mirror/gcc/releases/gcc-13.2.0/COPYING.RUNTIME', '9d6b43ce4d8de0c878bf16b54d8e7a10d9bd42b75178153e3af6a815bdc90f74'],
  ['mingw-license.txt', 'https://raw.githubusercontent.com/mingw-w64/mingw-w64/v11.0.1/COPYING', '99a69660981156c21336fdb5661f89341b013c94e4bf9e1c7467b4745718397f'],
  ['winpthreads-license.txt', 'https://raw.githubusercontent.com/mingw-w64/mingw-w64/v11.0.1/mingw-w64-libraries/winpthreads/COPYING', '63263614cdd29f2f93cba85e992f041b31f9fc7b4033692f31269489a8a1b177'],
];
async function hash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
async function exists(path) { try { await access(path); return true; } catch { return false; } }
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: root, windowsHide: true, encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024, stdio: capture ? 'pipe' : 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.status}`);
  return result.stdout?.trim();
}
async function download([name, url, expected]) {
  const path = join(cache, name);
  if (!await exists(path)) {
    console.log(`Downloading ${name}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const temporary = `${path}.download`;
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
      if (await hash(temporary) !== expected) throw new Error(`${name}: SHA256 mismatch`);
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
  if (await hash(path) !== expected) throw new Error(`${name}: cached SHA256 mismatch; remove this archive and retry`);
  return path;
}
async function sourceHash() {
  const digest = createHash('sha256');
  for (const name of ['CMakeLists.txt', 'bridge.cpp', 'split-shaders.mjs']) digest.update(name).update(await readFile(join(native, name)));
  digest.update(await readFile(fileURLToPath(import.meta.url)));
  return digest.digest('hex');
}
async function verify() {
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || manifest.backend !== 'vulkan' || manifest.sourceHash !== await sourceHash()) throw new Error('Native bundle is stale; run npm run build:speech-native');
  if (!Array.isArray(manifest.files) || !manifest.files.some(file => file.name === 'unilink-whisper.exe') || !manifest.files.some(file => file.name === 'THIRD-PARTY-NOTICES.txt')) throw new Error('Native manifest has no executable or notices');
  const expectedNames = ['manifest.json', ...manifest.files.map(file => file.name)].sort();
  if (JSON.stringify((await readdir(output)).sort()) !== JSON.stringify(expectedNames)) throw new Error('Native bundle contains unlisted or duplicate files');
  for (const file of manifest.files) {
    if (!/^[a-zA-Z0-9_+.-]+$/.test(file.name) || !/^[a-f0-9]{64}$/.test(file.sha256) || await hash(join(output, file.name)) !== file.sha256) throw new Error(`Native bundle failed verification: ${file.name}`);
  }
  console.log('Native speech bundle verified.');
}
const args = process.argv.slice(2);
if (args.some(arg => !['--verify-only'].includes(arg)) || args.length > 1) throw new Error('Usage: node scripts/build-speech-native.js [--verify-only]');
if (args.includes('--verify-only')) {
  await verify();
} else {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Native bundle requires Windows x64 with CMake, Ninja, MinGW g++ and objdump on PATH');
  await mkdir(cache, { recursive: true });
  // Prevent two builders from replacing the same generated sources or outputs.
  const lock = join(cache, 'unilink-build.lock');
  await mkdir(lock);
  try {
    const stageOnly = args.includes('--stage-only');
    const source = join(cache, 'whisper.cpp-1.9.4');
    const headers = join(cache, 'Vulkan-Headers-1.4.335', 'include');
    const spirv = join(cache, 'spirv-install');
    const build = join(cache, 'native-build');
    const loader = join(process.env.SystemRoot || 'C:/Windows', 'System32', 'vulkan-1.dll');
    for (const archive of archives) {
      const path = await download(archive);
      {
        const destination = archive[0] === 'shaderc.zip' ? join(cache, 'shaderc') : cache;
        await mkdir(destination, { recursive: true });
        run('tar.exe', ['-xf', path, '-C', destination]);
      }
    }
    const cpuFile = join(source, 'ggml', 'src', 'ggml-cpu', 'ggml-cpu.c');
    const cpu = await readFile(cpuFile, 'utf8');
    const original = '#if _WIN32_WINNT >= 0x0602';
    const patched = `${original} && defined(THREAD_POWER_THROTTLING_CURRENT_VERSION)`;
    if (cpu.split(original).length !== 2) throw new Error('Pinned MinGW compatibility patch no longer matches exactly once');
    {
      if (!cpu.includes(patched)) await writeFile(cpuFile, cpu.replace(original, patched));
      await cp(join(cache, 'Vulkan-Hpp-1.4.335', 'vulkan'), join(headers, 'vulkan'), { recursive: true });
      run('cmake.exe', ['-S', join(cache, 'SPIRV-Headers-vulkan-sdk-1.4.335.0'), '-B', join(cache, 'spirv-build'), '-G', 'Ninja', `-DCMAKE_INSTALL_PREFIX=${spirv}`]);
      run('cmake.exe', ['--install', join(cache, 'spirv-build')]);
      await access(loader);
      run('cmake.exe', ['-S', native, '-B', build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', `-DWHISPER_SOURCE_DIR=${source}`, `-DVulkan_INCLUDE_DIR:PATH=${headers}`, `-DVulkan_LIBRARY:FILEPATH=${loader}`, `-DVulkan_GLSLC_EXECUTABLE:FILEPATH=${join(cache, 'shaderc', 'install', 'bin', 'glslc.exe')}`, `-DCMAKE_PREFIX_PATH:PATH=${spirv}`, `-DCMAKE_CXX_FLAGS=-I"${join(spirv, 'include').replaceAll('\\', '/')}"`]);
      // Generated shader tables are large; concurrent C++ compilation can exhaust laptop memory.
      run('cmake.exe', ['--build', build, '--clean-first', '--target', 'unilink-whisper', '-j', '1']);
    }
    const executable = join(build, 'unilink-whisper.exe');
    const buildCache = await readFile(join(build, 'CMakeCache.txt'), 'utf8');
    if (!buildCache.includes('GGML_VULKAN:BOOL=ON') || !buildCache.includes('BUILD_SHARED_LIBS:BOOL=OFF')) throw new Error('Existing build is not the static Vulkan configuration');
    const executableStat = await stat(executable);
    for (const name of ['bridge.cpp', 'CMakeLists.txt', 'split-shaders.mjs']) {
      if ((await stat(join(native, name))).mtimeMs > executableStat.mtimeMs) throw new Error('Executable is older than native source; rebuild first');
    }
    const staging = join(root, 'build', 'speech-native-staging');
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging);
    await copyFile(executable, join(staging, 'unilink-whisper.exe'));
    const pending = ['unilink-whisper.exe'];
    const inspected = new Set();
    const runtimeNames = /^(libwinpthread-1|libgcc_s_seh-1|libstdc\+\+-6)\.dll$/i;
    while (pending.length) {
      const name = pending.pop();
      if (inspected.has(name.toLowerCase())) continue;
      inspected.add(name.toLowerCase());
      const imports = run('objdump.exe', ['-p', join(staging, name)], true);
      for (const match of imports.matchAll(/DLL Name:\s*(\S+)/g)) {
        const dependency = match[1];
        if (runtimeNames.test(dependency)) {
          const location = run('g++.exe', [`-print-file-name=${dependency}`], true);
          if (location === dependency) throw new Error(`Cannot locate MinGW runtime ${dependency}`);
          await copyFile(location, join(staging, dependency));
          pending.push(dependency);
        } else if (!/^api-ms-win-/i.test(dependency) && !await exists(join(process.env.SystemRoot || 'C:/Windows', 'System32', dependency))) {
          throw new Error(`Unexpected native dependency: ${dependency}`);
        }
      }
    }
    const noticeParts = ['Unilink native speech backend: whisper.cpp v1.9.4, GGML, Vulkan Headers/Hpp 1.4.335, SPIRV-Headers SDK 1.4.335.0.\nMinGW GCC runtime uses the GCC Runtime Library Exception. Vulkan loader and GPU driver are supplied by Windows/the GPU vendor, not bundled.\nSource: https://github.com/ggml-org/whisper.cpp/tree/v1.9.4\nBuild recipe and exact source hashes: scripts/build-speech-native.js\n'];
    for (const path of [join(source, 'LICENSE'), join(cache, 'Vulkan-Hpp-1.4.335', 'LICENSE.txt'), join(cache, 'Vulkan-Headers-1.4.335', 'LICENSE.md'), join(cache, 'SPIRV-Headers-vulkan-sdk-1.4.335.0', 'LICENSE')]) noticeParts.push(`${path.slice(cache.length + 1)}\n${await readFile(path, 'utf8')}`);
    for (const directory of ['Vulkan-Headers-1.4.335', 'SPIRV-Headers-vulkan-sdk-1.4.335.0']) {
      for (const name of (await readdir(join(cache, directory, 'LICENSES'))).sort()) noticeParts.push(`${directory}/${name}\n${await readFile(join(cache, directory, 'LICENSES', name), 'utf8')}`);
    }
    for (const name of ['miniaudio.h', 'stb_vorbis.c']) {
      const text = await readFile(join(source, 'examples', name), 'utf8');
      const start = text.lastIndexOf('This software is available');
      if (start < 0) throw new Error(`Missing bundled license in ${name}`);
      noticeParts.push(`${name}\n${text.slice(start)}`);
    }
    const mit = await readFile(join(source, 'LICENSE'), 'utf8');
    noticeParts.push(`JSON for Modern C++ 3.11.2\nCopyright 2013-2022 Niels Lohmann <https://nlohmann.me>\n${mit.slice(mit.indexOf('Permission is hereby granted'))}`);
    for (const license of licenses) noticeParts.push(`${license[1]}\n${await readFile(await download(license), 'utf8')}`);
    await writeFile(join(staging, 'THIRD-PARTY-NOTICES.txt'), noticeParts.join('\n\n--------------------\n\n'));
    const files = [];
    for (const name of (await readdir(staging)).sort()) files.push({ name, sha256: await hash(join(staging, name)) });
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify({ version: 1, backend: 'vulkan', whisperVersion: '1.9.4', sourceHash: await sourceHash(), compiler: run('g++.exe', ['--version'], true).split('\n')[0], archives: archives.map(([name, url, sha256]) => ({ name, url, sha256 })), files }, null, 2)}\n`);
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
    await verify();
  } finally { await rm(lock, { recursive: true, force: true }); }
}
