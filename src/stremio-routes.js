import { isLocalNetworkAddress } from "./network.js";
import { isIP } from "node:net";

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export function sameOriginRequest(request, allowNavigation = false) {
  try {
    const target = new URL(`http://${request.headers.host}`);
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    const navigation = allowNavigation && request.method === "GET" &&
      request.headers["sec-fetch-mode"] === "navigate" && request.headers["sec-fetch-dest"] === "document";
    return (hostname === "localhost" || (isIP(hostname) && isLocalNetworkAddress(hostname))) &&
      (navigation || ((!request.headers.origin || request.headers.origin === target.origin) &&
        request.headers["sec-fetch-site"] !== "cross-site"));
  } catch { return false; }
}

export async function handleStremioRequest({ request, response, pathname, sync, registry,
  serverInstanceId, adminToken, progressToken, loopback }) {
  const admin = pathname.startsWith("/api/stremio/");
  if (!admin && pathname !== "/api/progress") return false;
  if (!sameOriginRequest(request) || (admin && !loopback)) {
    json(response, 403, { error: "Acceso no permitido." });
    return true;
  }
  if (admin && pathname === "/api/stremio/status" && request.method === "GET") {
    json(response, 200, await sync.status());
    return true;
  }
  if (request.method !== "POST" || request.headers["x-unilink-token"] !== (admin ? adminToken : progressToken)) {
    json(response, 403, { error: "Acceso no permitido." });
    return true;
  }
  try {
    if (pathname === "/api/stremio/connect") json(response, 200, await sync.connect());
    else if (pathname === "/api/stremio/poll") json(response, 200, await sync.pollLink());
    else if (pathname === "/api/stremio/disconnect") json(response, 200, await sync.disconnect());
    else if (pathname === "/api/progress") {
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 2048) {
          json(response, 413, { state: "invalid" });
          return true;
        }
      }
      let body;
      try { body = JSON.parse(raw); } catch { body = null; }
      if (!body || typeof body !== "object") {
        json(response, 400, { state: "invalid" });
        return true;
      }
      const active = registry.active;
      const isCurrent = () => active && registry.active === active && body.version === active.version && body.serverInstanceId === serverInstanceId;
      if (!isCurrent()) json(response, 409, { state: "stale" });
      else {
        const result = await sync.report(active, body, isCurrent);
        json(response, result.state === "invalid" ? 400 : 200, result);
      }
    } else json(response, 404, { error: "No encontrado." });
  } catch {
    json(response, 502, { state: "error" });
  }
  return true;
}
