import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSubtitleTracks,
  shiftWebVtt,
  subtitlesResourceUrl,
} from "../src/subtitles.js";

test("construye el recurso de subtítulos para el mismo contenido", () => {
  assert.equal(
    subtitlesResourceUrl(
      "https://opensubtitles-v3.strem.io/manifest.json",
      "series",
      "tt0944947:1:1",
    ),
    "https://opensubtitles-v3.strem.io/subtitles/series/tt0944947%3A1%3A1.json",
  );
});

test("normaliza y deduplica pistas compatibles", () => {
  assert.deepEqual(
    normalizeSubtitleTracks([
      { id: "one", lang: "spa", url: "https://example.com/es.srt" },
      { id: "duplicate", lang: "spa", url: "https://example.com/es.srt" },
      { id: "two", lang: "eng", url: "https://example.com/en.srt" },
      { id: "two", lang: "eng", url: "https://example.com/en-2.srt" },
      { id: "bad", lang: "fra", url: "file:///subtitle.srt" },
    ]),
    [
      {
        id: "one",
        lang: "spa",
        language: "es",
        label: "Español",
        url: "https://example.com/es.srt",
      },
      {
        id: "two",
        lang: "eng",
        language: "en",
        label: "Inglés",
        url: "https://example.com/en.srt",
      },
      {
        id: "two-2",
        lang: "eng",
        language: "en",
        label: "Inglés",
        url: "https://example.com/en-2.srt",
      },
    ],
  );
});

test("aplica un delay positivo o negativo a WebVTT", () => {
  const source =
    "WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nHola\n";

  assert.equal(
    shiftWebVtt(source, 1.5),
    "WEBVTT\n\n00:00:02.500 --> 00:00:05.000\nHola\n",
  );
  assert.equal(
    shiftWebVtt(source, -0.5),
    "WEBVTT\n\n00:00:00.500 --> 00:00:03.000\nHola\n",
  );
});
