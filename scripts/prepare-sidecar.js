import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const targetTriple = execFileSync("rustc", ["--print", "host-tuple"], {
  encoding: "utf8",
}).trim();

if (!/^[a-zA-Z0-9_.-]+$/.test(targetTriple)) {
  throw new Error(`Target de Rust no válido: ${targetTriple}`);
}

const extension = process.platform === "win32" ? ".exe" : "";
const source = resolve("build", `unilink-server${extension}`);
const destination = resolve(
  "src-tauri",
  "binaries",
  `unilink-server-${targetTriple}${extension}`,
);

await mkdir(dirname(destination), { recursive: true });
await rm(destination, { force: true });
try {
  await rename(source, destination);
} catch (error) {
  if (error.code !== "EXDEV") {
    throw error;
  }
  await copyFile(source, destination);
  await rm(source);
}
console.log(`Sidecar preparado: ${destination}`);
