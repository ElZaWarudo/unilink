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
} from "../src/player.js";

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
