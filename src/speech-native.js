import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// The immutable content hash also protects against an upstream model revision.
export const NATIVE_MODEL = {
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
  sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
};
const bundle = new URL('../build/speech-native/', import.meta.url);

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function nativeInstalled(paths) {
  return Promise.all([access(paths.nativeExecutable), access(paths.nativeModel)]).then(() => true, () => false);
}

export async function installNative(paths, signal, { source = bundle, fetchImpl = fetch, model = NATIVE_MODEL } = {}) {
  signal.throwIfAborted();
  const manifest = JSON.parse(await readFile(new URL('manifest.json', source), 'utf8'));
  if (manifest.version !== 1 || manifest.backend !== 'vulkan' || manifest.whisperVersion !== '1.9.4' ||
      !Array.isArray(manifest.files) || manifest.files.length > 20 ||
      !manifest.files.some(file => file.name === 'unilink-whisper.exe') ||
      manifest.files.some(file => !/^[a-zA-Z0-9_+-]+\.(exe|dll|txt)$/.test(file.name) || !/^[a-f0-9]{64}$/i.test(file.sha256))) {
    throw new Error('Invalid bundled speech engine');
  }
  // Validate every bundled byte before replacing any installed file.
  const files = await Promise.all(manifest.files.map(async file => {
    const bytes = await readFile(new URL(file.name, source));
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256.toLowerCase()) throw new Error('Invalid bundled speech engine');
    return { name: file.name, bytes };
  }));
  signal.throwIfAborted();
  await mkdir(dirname(paths.nativeExecutable), { recursive: true });
  for (const file of files) {
    signal.throwIfAborted();
    await writeFile(join(dirname(paths.nativeExecutable), file.name), file.bytes);
  }
  if (await digest(paths.nativeModel).catch(() => '') === model.sha256) return;
  const temporary = `${paths.nativeModel}.download`;
  try {
    const response = await fetchImpl(model.url, { signal });
    if (!response.ok || !response.body) throw new Error('Model download failed');
    let size = 0;
    async function* bounded(stream) {
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > 200_000_000) throw new Error('Model download too large');
        yield chunk;
      }
    }
    await pipeline(bounded(Readable.fromWeb(response.body)), createWriteStream(temporary), { signal });
    if (await digest(temporary) !== model.sha256) throw new Error('Invalid speech model download');
    signal.throwIfAborted();
    await rename(temporary, paths.nativeModel);
  } finally {
    await rm(temporary, { force: true });
  }
}
