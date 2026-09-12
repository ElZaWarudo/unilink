import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { activationPage } from "../src/pages.js";

const flush = () => new Promise(resolve => setImmediate(resolve));
function harness({ preparing = false } = {}) {
  const nodes = new Map();
  function node(selector, value = "") {
    const item = { value, textContent: "", handlers: {}, dataset: {},
      addEventListener(name, callback) { this.handlers[name] = callback; },
      querySelector(selector) { return nodes.get(selector); } };
    nodes.set(selector, item); return item;
  }
  const language = node("#subtitleLanguage", "en");
  const source = node("#subtitleSource", "en");
  source.options = [{ value: "en", dataset: { language: "en" } }];
  source.selectedOptions = source.options;
  const input = node("#subtitleDelay", "-2");
  const output = node("[data-subtitle-delay-output]");
  const current = node("[data-subtitle-sync-current]");
  const label = node("#subtitleDelayLabel");
  const stepper = node("[data-subtitle-delay-stepper]");
  const reset = node("[data-subtitle-delay-reset]");
  const state = node("[data-subtitle-sync-state]");
  const status = node("[data-subtitle-settings-status]");
  const preparation = node("[data-preparation-state]");
  const form = node("[data-subtitle-settings]"); form.action = "/settings";
  node('[type="submit"]');
  const requests = [], timers = [], events = {}, replacements = [];
  const html = activationPage({ watchUrl: "/watch", serverInstanceId: "instance", preparing,
    active: { version: 12, title: "Movie", subtitles: [{ id: "en", language: "en", label: "English" }],
      playbackSettings: { subtitleDelay: -2, subtitleLanguage: "en", subtitleId: "en" } } });
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(text => text.includes("const copyButton"));
  vm.runInNewContext(script, {
    document: { querySelector: selector => nodes.get(selector), querySelectorAll: () => [] },
    window: { addEventListener: (name, callback) => { events[name] = callback; } },
    location: { replace: path => replacements.push(path) },
    fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
    setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {},
    AbortController, AbortSignal, URLSearchParams,
    FormData: class { *[Symbol.iterator]() { yield ["subtitleDelay", input.value]; } },
  });
  const report = (extra = {}) => ({ active: true, version: 12, serverInstanceId: "instance",
    subtitleLanguage: "en", subtitleId: "en", subtitleDelay: -2,
    subtitleSync: { enabled: true, state: "ready", effectiveDelay: 1.46, manualBaseline: -2 }, ...extra });
  async function reply(value = report(), index = requests.length - 1) {
    requests[index].resolve({ ok: true, status: 200, json: async () => value }); await flush();
  }
  function click(change) {
    stepper.handlers.click({ target: { closest: selector => selector === "[data-subtitle-delay-reset]" ?
      (change === "reset" ? reset : null) : (change === "reset" ? null : { dataset: { subtitleDelayChange: change } }) } });
  }
  return { input, output, current, label, state, status, preparation, replacements, form, language, requests, timers, events, report, reply, click };
}

test("preparation completion preserves pending caption edits", async () => {
  const h = harness({ preparing: true });
  await h.reply(h.report({ preparing: true }), 0);
  h.click("0.05");
  await h.reply(h.report({ preparing: false }), 1);
  assert.equal(h.input.value, "-1.95");
  assert.deepEqual(h.replacements, []);
  assert.match(h.preparation.textContent, /ajustes pendientes se conservan/);
});

test("PC live timing includes autosync while fine tuning preserves the raw baseline", async () => {
  const h = harness(); await h.reply();
  assert.equal(h.current.textContent, "+1,46 s");
  assert.equal(h.label.textContent, "Ajuste adicional");
  assert.equal(h.output.textContent, "0,00 s");
  assert.equal(h.input.value, "-2");
  h.click("0.05"); assert.equal(h.output.textContent, "+0,05 s");
  h.timers.shift()(); await h.reply(h.report({ subtitleDelay: 3, subtitleSync: null }));
  assert.equal(h.input.value, "-1.95");
  assert.equal(h.label.textContent, "Ajuste adicional");
  assert.equal(h.current.textContent, "Esperando al reproductor…");
  h.click("reset"); assert.equal(h.input.value, "-2");
  const submitted = h.form.handlers.submit({ preventDefault() {} });
  assert.equal(h.requests.at(-1).options.body.get("subtitleDelay"), "-2");
  await h.reply(h.report({ subtitleSync: { enabled: false, effectiveDelay: -2, manualBaseline: 0 } }));
  await submitted;
  assert.equal(h.label.textContent, "Sincronización");
  assert.equal(h.output.textContent, "−2,00 s");
  h.click("reset"); assert.equal(h.input.value, "0");
});

test("PC poll stops on replaced session and aborts when closed", async () => {
  const h = harness(); await h.reply(h.report({ version: 13 }));
  assert.match(h.status.textContent, /fuente ha cambiado/);
  assert.equal(h.timers.length, 0);
  await h.form.handlers.submit({ preventDefault() {} });
  assert.equal(h.requests.length, 1);
  const other = harness(); other.events.pagehide();
  assert.equal(other.requests[0].options.signal.aborted, true);
  await other.reply(); assert.equal(other.timers.length, 0);
});

test("an edit made during apply survives the response", async () => {
  const h = harness(); await h.reply(); h.click("0.05");
  const submitted = h.form.handlers.submit({ preventDefault() {} });
  h.click("0.05");
  await h.reply(h.report({ subtitleDelay: -1.95 })); await submitted;
  assert.equal(h.input.value, "-1.9"); assert.equal(h.output.textContent, "+0,10 s");
});

test("an older poll cannot replace settings after a successful apply", async () => {
  const h = harness(); await h.reply();
  h.timers.shift()();
  const oldPoll = h.requests.length - 1;
  h.click("0.05");
  const submitted = h.form.handlers.submit({ preventDefault() {} });
  await h.reply(h.report({ subtitleDelay: -1.95 })); await submitted;
  await h.reply(h.report(), oldPoll);
  assert.equal(h.input.value, "-1.95");
  assert.equal(h.output.textContent, "+0,05 s");
});
