import { mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { speechPaths } from "../src/subtitle-sync.js";

const paths = speechPaths();
const venv = dirname(dirname(paths.python));
await mkdir(dirname(venv), { recursive: true });
const run = (command, args) => execFileSync(command, args, { stdio: "inherit", windowsHide: true });
const python = process.env.UNILINK_SETUP_PYTHON || (process.platform === "win32" ? "python" : "python3");
run(python, ["-c", "import sys; assert sys.version_info >= (3,10), 'Subtitle synchronization needs Python 3.10 or newer'"]);
run(python, ["-m", "venv", venv]);
run(paths.python, ["-m", "pip", "install", "faster-whisper==1.2.1", "ctranslate2==4.8.2"]);
run(paths.python, ["-c", "from huggingface_hub import snapshot_download; import sys; snapshot_download('Systran/faster-whisper-base.en', local_dir=sys.argv[1], allow_patterns=['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.*'])", paths.model]);
console.log("Motor de sincronización en inglés instalado. Activa Auto-sync inglés en el reproductor.");
