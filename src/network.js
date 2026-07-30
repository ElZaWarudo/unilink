import { networkInterfaces } from "node:os";

function scoreAddress(address) {
  if (/^192\.168\.1\./.test(address) || /^192\.168\.0\./.test(address)) {
    return 100;
  }
  if (/^192\.168\./.test(address)) {
    return 80;
  }
  if (/^10\./.test(address)) {
    return 70;
  }
  const match = address.match(/^172\.(\d+)\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) {
    return 60;
  }
  return 10;
}

export function listLanAddresses(interfaces = networkInterfaces()) {
  return Object.values(interfaces)
    .flatMap((addresses) => addresses ?? [])
    .filter(
      (address) =>
        address.family === "IPv4" &&
        !address.internal &&
        !address.address.startsWith("169.254."),
    )
    .map((address) => address.address)
    .filter((address, index, all) => all.indexOf(address) === index)
    .sort((left, right) => scoreAddress(right) - scoreAddress(left));
}

export function selectLanAddress(override, interfaces) {
  if (override) {
    return override;
  }
  return listLanAddresses(interfaces)[0] ?? "127.0.0.1";
}

export function isLocalNetworkAddress(value = "") {
  const address = value.replace(/^::ffff:/, "").toLowerCase();
  if (address === "127.0.0.1" || address === "::1") {
    return true;
  }
  if (
    address.startsWith("10.") ||
    address.startsWith("192.168.") ||
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    address.startsWith("fe80:")
  ) {
    return true;
  }
  const match = address.match(/^172\.(\d+)\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}
