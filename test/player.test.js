import assert from "node:assert/strict";
import test from "node:test";

import {
  adjustSubtitleDelay,
  formatSubtitleDelay,
  normalizeSubtitleDelay,
} from "../src/subtitle-delay.js";
import {
  cueAtTime,
  parseWebVtt,
  resumeTime,
  seekTargetTime,
  shouldStartMarathonCountdown,
  shouldReloadPlayer,
  audioTrackLabel,
  preferredAudioTrack,
  startAudioPlayback,
} from "../src/player.js";

test("identifica idiomas y distingue varias pistas del mismo idioma", () => {
  assert.equal(audioTrackLabel({ lang: "spa", name: "spa" }, 0), "Español · Pista 1");
  assert.equal(audioTrackLabel({ lang: "spa", name: "Comentarios" }, 1), "Español · Comentarios · Pista 2");
  assert.equal(audioTrackLabel({}, 0), "Pista 1");
});

test("recuerda la pista por idioma y nombre sin reutilizar índices de otro episodio", () => {
  const tracks = [{ lang: "eng", name: "Original" }, { lang: "spa", name: "Doblaje" }];
  assert.equal(preferredAudioTrack(tracks, { lang: "spa", name: "Doblaje" }), 1);
  assert.equal(preferredAudioTrack(tracks, { lang: "spa", name: "Otro nombre" }), 1);
  assert.equal(preferredAudioTrack(tracks, { lang: "fra" }), -1);
});

test("cambia el audio sin reiniciar el vídeo y libera HLS al salir", (t) => {
  const oldDocument = globalThis.document;
  const oldStorage = globalThis.localStorage;
  globalThis.document = { createElement: () => ({}) };
  const stored = new Map();
  globalThis.localStorage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  t.after(() => { globalThis.document = oldDocument; globalThis.localStorage = oldStorage; });
  let instance;
  class FakeHls {
    static isSupported = () => true;
    static Events = { AUDIO_TRACKS_UPDATED: "tracks", AUDIO_TRACK_SWITCHED: "switched", ERROR: "error" };
    constructor() { instance = this; this.callbacks = {}; this.audioTracks = [{ lang: "spa" }, { lang: "eng" }]; this.audioTrack = 0; }
    on(event, fn) { this.callbacks[event] = fn; }
    loadSource(url) { this.url = url; }
    attachMedia(video) { this.video = video; }
    stopLoad() { this.stopped = true; }
    destroy() { this.destroyed = true; }
  }
  const video = Object.assign(new EventTarget(), { currentTime: 120, paused: false });
  const select = Object.assign(new EventTarget(), { replaceChildren() {}, append() {} });
  let failure;
  const player = startAudioPlayback({ video, select, url: "/hls/test/master.m3u8", Hls: FakeHls, onError: text => { failure = text; } });
  instance.callbacks.tracks();
  assert.equal(select.disabled, false);
  select.value = "1";
  select.dispatchEvent(new Event("change"));
  assert.equal(instance.audioTrack, 1);
  assert.equal(video.currentTime, 120);
  assert.equal(video.paused, false);
  assert.equal(JSON.parse(stored.get("unilink:audio")).lang, "en");
  instance.callbacks.error(null, { fatal: true });
  assert.match(failure, /Reintentar/);
  assert.equal(instance.stopped, true);
  assert.equal(select.disabled, true);
  player.destroy();
  assert.equal(instance.destroyed, true);
});

test("selecciona audio nativo sin AudioTrack API y restaura posición y reproducción", async (t) => {
  const oldDocument = globalThis.document;
  globalThis.document = { createElement: () => ({}) };
  t.after(() => { globalThis.document = oldDocument; });
  const video = Object.assign(new EventTarget(), {
    currentTime: 0, paused: true, canPlayType: () => "probably",
    play: async () => { video.paused = false; },
  });
  const select = Object.assign(new EventTarget(), { replaceChildren() {}, append() {} });
  const playback = startAudioPlayback({ video, select, Hls: null, url: "/hls/session/1/master.m3u8", onError: assert.fail,
    fetchImpl: async () => Response.json({ tracks: [{ lang: "spa", default: true }, { lang: "eng" }] }),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(video.src, "/hls/session/1/master.m3u8?audio=0");
  video.dispatchEvent(new Event("loadedmetadata"));
  video.currentTime = 180;
  video.paused = false;
  select.value = "1";
  select.dispatchEvent(new Event("change"));
  assert.equal(video.src, "/hls/session/1/master.m3u8?audio=1");
  video.currentTime = 0;
  video.paused = true;
  video.dispatchEvent(new Event("loadedmetadata"));
  assert.equal(video.currentTime, 180);
  assert.equal(video.paused, false);
  playback.destroy();
});

const SAMPLE_VTT = `WEBVTT

1
00:01.000 --> 00:02.000
Primera línea
Segunda línea

00:03.500 --> 00:04.500 align:middle
Otro subtítulo
`;

test("analiza cues WebVTT con identificador, varias líneas y ajustes", () => {
  assert.deepEqual(parseWebVtt(SAMPLE_VTT), [
    {
      start: 1,
      end: 2,
      text: "Primera línea\nSegunda línea",
    },
    {
      start: 3.5,
      end: 4.5,
      text: "Otro subtítulo",
    },
  ]);
});

test("aplica el delay al buscar el cue sin modificar ni recargar la pista", () => {
  const cues = parseWebVtt(SAMPLE_VTT);

  assert.equal(cueAtTime(cues, 1.5, 0)?.text, "Primera línea\nSegunda línea");
  assert.equal(cueAtTime(cues, 1.5, 1), null);
  assert.equal(cueAtTime(cues, 2.5, 1)?.text, "Primera línea\nSegunda línea");
  assert.equal(cueAtTime(cues, 0.5, -0.5)?.text, "Primera línea\nSegunda línea");
});

test("ajusta la sincronización en pasos exactos de 0,05 segundos", () => {
  assert.equal(adjustSubtitleDelay(0, 0.05), 0.05);
  assert.equal(adjustSubtitleDelay(0.05, 0.05), 0.1);
  assert.equal(adjustSubtitleDelay(0.1, -0.05), 0.05);
  assert.equal(normalizeSubtitleDelay(31), 30);
  assert.equal(normalizeSubtitleDelay(-31), -30);
  assert.equal(normalizeSubtitleDelay("no válido"), 0);
});

test("presenta el delay con signo y dos decimales", () => {
  assert.equal(formatSubtitleDelay(0), "0,00 s");
  assert.equal(formatSubtitleDelay(0.05), "+0,05 s");
  assert.equal(formatSubtitleDelay(-1.5), "−1,50 s");
});

test("restaura una posición válida sin saltar al final de la película", () => {
  assert.equal(resumeTime("125.5", 7200), 125.5);
  assert.equal(resumeTime("7198", 7200), null);
  assert.equal(resumeTime("-1", 7200), null);
  assert.equal(resumeTime("texto", 7200), null);
});

test("limita los saltos de reproducción al inicio y al final", () => {
  assert.equal(seekTargetTime(120, 7200, -10), 110);
  assert.equal(seekTargetTime(120, 7200, 10), 130);
  assert.equal(seekTargetTime(4, 7200, -10), 0);
  assert.equal(seekTargetTime(7195, 7200, 10), 7200);
  assert.equal(seekTargetTime(20, Number.NaN, 10), 30);
  assert.equal(seekTargetTime("texto", 7200, 10), 0);
});

test("recarga cuando el servidor reinicia aunque la versión coincida", () => {
  const expected = {
    version: 2,
    serverInstanceId: "server-before-restart",
  };

  assert.equal(
    shouldReloadPlayer(
      { version: 2, serverInstanceId: "server-before-restart" },
      expected,
    ),
    false,
  );
  assert.equal(
    shouldReloadPlayer(
      { version: 3, serverInstanceId: "server-before-restart" },
      expected,
    ),
    true,
  );
  assert.equal(
    shouldReloadPlayer(
      { version: 2, serverInstanceId: "server-after-restart" },
      expected,
    ),
    true,
  );
});

test("inicia la cuenta atrás solo al terminar con autoplay preparado", () => {
  assert.equal(
    shouldStartMarathonCountdown({
      ended: true,
      autoplay: true,
      canAdvance: true,
      itemCount: 2,
    }),
    true,
  );
  assert.equal(
    shouldStartMarathonCountdown({
      ended: true,
      autoplay: false,
      canAdvance: true,
      itemCount: 2,
    }),
    false,
  );
  assert.equal(
    shouldStartMarathonCountdown({
      ended: false,
      autoplay: true,
      canAdvance: true,
      itemCount: 2,
    }),
    false,
  );
  assert.equal(
    shouldStartMarathonCountdown({
      ended: true,
      autoplay: true,
      canAdvance: false,
      itemCount: 0,
    }),
    false,
  );
});
