import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { activationPage, configurationPage, watchPage } from "../src/pages.js";

test("speech backend controls preserve a pending choice and display confirmed CPU fallback", async () => {
  const nodes = new Map();
  const node = selector => {
    const value = { value: "cpu", dataset: { token: "host-token" }, handlers: {},
      querySelector: key => nodes.get(key), setAttribute() {},
      addEventListener: (event, callback) => { value.handlers[event] = callback; } };
    nodes.set(selector, value); return value;
  };
  for (const selector of ["[data-speech-setup]", "[data-speech-setup-status]", "[data-speech-setup-start]",
    "[data-speech-backend]", "[data-speech-backend-apply]", "[data-speech-backend-status]"]) node(selector);
  const requests = [], timers = [], events = {};
  const html = configurationPage({ manifestUrl: "http://127.0.0.1:17891/manifest.json" });
  const script = html.slice(html.indexOf("const speech = document"), html.indexOf("window.addEventListener('pageshow'"));
  vm.runInNewContext(script, { document: { querySelector: selector => nodes.get(selector) },
    fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
    setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {},
    AbortController, AbortSignal, window: { addEventListener: (event, callback) => { events[event] = callback; } } });
  const reply = async value => { requests.at(-1).resolve({ ok: true, json: async () => value }); await new Promise(resolve => setImmediate(resolve)); };
  const status = { requestedBackend: "cpu", state: "ready", busy: false, message: "Disponible" };
  await reply(status);
  const select = nodes.get("[data-speech-backend]"), apply = nodes.get("[data-speech-backend-apply]");
  assert.equal(apply.disabled, true);
  select.value = "vulkan"; select.handlers.change();
  timers.shift()(); await reply(status);
  assert.equal(select.value, "vulkan");
  assert.equal(apply.disabled, false);
  const pending = apply.handlers.click();
  assert.equal(requests.at(-1).url, "/api/speech-backend");
  assert.equal(JSON.parse(requests.at(-1).options.body).backend, "vulkan");
  assert.equal(select.disabled, true);
  await reply({ ...status, requestedBackend: "vulkan", runtime: { backend: "cpu", fallbackReason: "vulkan_failed" } });
  await pending;
  assert.equal(select.value, "vulkan");
  assert.equal(apply.disabled, true);
  assert.match(nodes.get("[data-speech-backend-status]").textContent, /GPU no disponible; usando CPU/);
  events.pagehide();
  assert.equal(requests.at(-1).options.signal.aborted, true);
});

test("setup completes the viewing handoff and labels account linking optional", () => {
  const html = configurationPage({ manifestUrl: "http://127.0.0.1:17891/manifest.json", watchUrl: "http://192.168.1.2:17891/watch" });
  assert.match(html, /http:\/\/192\.168\.1\.2:17891\/watch/);
  assert.match(html, /Copiar URL/);
  assert.match(html, /Opcional/);
  assert.doesNotMatch(html, /Servir en red/);
});

test("handoff binds settings to the selected session and reports pending preparation", () => {
  const html = activationPage({ watchUrl: "/watch", serverInstanceId: "test-instance", preparing: true,
    active: { version: 12, title: "A movie", subtitles: [{ id: "en", language: "en", label: "English" }] } });
  assert.match(html, /name="serverInstanceId" value="test-instance"/);
  assert.match(html, /name="version" value="12"/);
  assert.match(html, /Preparando subtítulos/);
  assert.match(html, /\/api\/status/);
});

test("waiting page polls without replacing the document on every timer", () => {
  const html = watchPage({});
  assert.doesNotMatch(html, /setTimeout\(\(\) => location\.reload\(\), 3000\)/);
  assert.match(html, /\/api\/status/);
  assert.doesNotMatch(html, /Servir en red/);
});

test("watch controls group compact autosync next to captions without a PC configuration link", () => {
  const html = watchPage({ active: { version: 1, title: "Movie", url: "http://example.test/video", subtitles: [] } });
  assert.match(html, /data-player-control="captions"[\s\S]*?>CC<\/button>\s*<button data-player-control="subtitle-sync"/);
  assert.match(html, /disabled>Auto-sync<\/button>/);
  assert.doesNotMatch(html, /Configurar en el PC/);
});

test("restoring a preparation page returns to current session after aborting its old request", () => {
  const html = activationPage({ watchUrl: "/watch", serverInstanceId: "instance", preparing: true,
    active: { version: 12, title: "A movie" } });
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(text => text.includes("pollPreparation"));
  assert.ok(script);
  const handlers = {}; const replacements = []; let signal;
  vm.runInNewContext(script.slice(script.lastIndexOf("(() => {")), {
    document: { querySelectorAll: () => [] },
    window: { addEventListener: (name, fn) => { handlers[name] = fn; } },
    location: { replace: url => replacements.push(url) },
    fetch: (_url, options) => { signal = options.signal; return new Promise(() => {}); },
    AbortController, AbortSignal, setTimeout: () => 1, clearTimeout() {},
  });
  handlers.pagehide(); assert.equal(signal.aborted, true);
  handlers.pageshow({ persisted: false }); assert.deepEqual(replacements, []);
  handlers.pageshow({ persisted: true }); assert.deepEqual(replacements, ["/session"]);
});
