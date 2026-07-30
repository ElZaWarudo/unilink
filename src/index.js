import { resolve } from "node:path";

import { ConfigStore } from "./config.js";
import { selectLanAddress } from "./network.js";
import { createUnilinkServer } from "./server.js";
import { StreamRegistry } from "./streams.js";

const port = Number.parseInt(process.env.UNILINK_PORT ?? "17891", 10);
const host = process.env.UNILINK_HOST ?? "0.0.0.0";
const localBaseUrl = `http://127.0.0.1:${port}`;

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("UNILINK_PORT debe ser un puerto válido.");
}

const lanBaseUrl = `http://${selectLanAddress(process.env.UNILINK_LAN_HOST)}:${port}`;
const server = createUnilinkServer({
  configStore: new ConfigStore(
    resolve(process.env.UNILINK_DATA_DIR ?? "data", "config.json"),
  ),
  registry: new StreamRegistry(),
  activationBaseUrl: localBaseUrl,
  manifestUrl: `${localBaseUrl}/manifest.json`,
  watchUrl: `${lanBaseUrl}/watch`,
  stremioServerUrl:
    process.env.STREMIO_SERVER_URL ?? "http://127.0.0.1:11470",
  metadataManifestUrl:
    process.env.UNILINK_METADATA_MANIFEST_URL ??
    "https://v3-cinemeta.strem.io/manifest.json",
});

server.listen(port, host, () => {
  console.log("Unilink está listo.");
  console.log(`Configura Torrentio: ${localBaseUrl}/configure`);
  console.log(`Instala el addon:     ${localBaseUrl}/manifest.json`);
  console.log(`Segunda pantalla:     ${lanBaseUrl}/watch`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
