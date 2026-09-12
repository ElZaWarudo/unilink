// Split generated declarations without changing any shader bytes or symbols.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('Expected shader table and output directory');
const text = await readFile(source, 'utf8');
const starts = [...text.matchAll(/^const uint64_t [a-zA-Z0-9_]+_len = [0-9]+;\r?$/gm)].map(match => match.index);
if (!starts.length || !/^#include "ggml-vulkan-shaders.hpp"\s+$/.test(text.slice(0, starts[0]))) {
  throw new Error('Unexpected generated shader table');
}
const header = text.slice(0, starts[0]);
const parts = Array.from({ length: 16 }, () => []);
const targetSize = Math.ceil((text.length - header.length) / parts.length);
let part = 0, size = 0;
for (let index = 0; index < starts.length; index++) {
  const declaration = text.slice(starts[index], starts[index + 1] ?? text.length);
  if (size >= targetSize && part < parts.length - 1) { part++; size = 0; }
  parts[part].push(declaration);
  size += declaration.length;
}
await mkdir(destination, { recursive: true });
for (let index = 0; index < parts.length; index++) {
  await writeFile(join(destination, `mul-mm-${index}.cpp`), header + parts[index].join(''));
}
