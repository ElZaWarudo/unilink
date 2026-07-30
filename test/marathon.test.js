import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_METADATA_MANIFEST_URL,
  metadataResourceUrl,
  parseSeriesVideoId,
  rankMarathonStreams,
  seriesQueueVideos,
} from "../src/marathon.js";

test("identifica episodios de series con ID IMDb", () => {
  assert.deepEqual(parseSeriesVideoId("tt0944947:2:3"), {
    imdbId: "tt0944947",
    season: 2,
    episode: 3,
    videoId: "tt0944947:2:3",
  });
  assert.equal(parseSeriesVideoId("tt0944947"), null);
  assert.equal(parseSeriesVideoId("custom:2:3"), null);
  assert.equal(parseSeriesVideoId("tt0944947:0:0"), null);
});

test("construye el recurso de metadatos de la serie", () => {
  assert.equal(
    metadataResourceUrl(
      DEFAULT_METADATA_MANIFEST_URL,
      "tt0944947",
    ),
    "https://v3-cinemeta.strem.io/meta/series/tt0944947.json",
  );
});

test("ordena y selecciona los episodios posteriores", () => {
  const videos = [
    {
      id: "tt0944947:2:2",
      title: "Segundo",
      season: 2,
      episode: 2,
      thumbnail: "https://images.example/2-2.jpg",
    },
    {
      id: "tt0944947:1:2",
      title: "Anterior",
      season: 1,
      episode: 2,
    },
    {
      id: "tt0944947:2:4",
      title: "Cuarto",
      season: 2,
      episode: 4,
    },
    {
      id: "otra-serie:2:5",
      title: "No pertenece",
      season: 2,
      episode: 5,
    },
    {
      id: "tt0944947:2:3",
      title: "Tercero",
      season: 2,
      episode: 3,
    },
  ];

  assert.deepEqual(
    seriesQueueVideos(videos, "tt0944947:2:2", { limit: 2 }),
    [
      {
        id: "tt0944947:2:3",
        title: "Tercero",
        season: 2,
        episode: 3,
        thumbnail: "",
        released: "",
      },
      {
        id: "tt0944947:2:4",
        title: "Cuarto",
        season: 2,
        episode: 4,
        thumbnail: "",
        released: "",
      },
    ],
  );
});

test("prioriza fuentes parecidas a la elegida en el episodio actual", () => {
  const current = {
    name: "Torrentio 1080p",
    description: "WEB-DL · H264 · AAC · 2.1 GB",
  };
  const candidates = [
    {
      name: "Torrentio 2160p",
      description: "WEB-DL · HEVC · HDR · 8 GB",
      url: "https://example.com/4k.mkv",
    },
    {
      name: "Torrentio 1080p",
      description: "WEBRip · H265 · AAC · 1.8 GB",
      url: "https://example.com/webrip.mkv",
    },
    {
      name: "Torrentio 1080p",
      description: "WEB-DL · H264 · AAC · 2.2 GB",
      url: "https://example.com/preferred.mp4",
    },
  ];

  const ranked = rankMarathonStreams(current, candidates);

  assert.equal(ranked[0].url, "https://example.com/preferred.mp4");
  assert.equal(ranked[1].url, "https://example.com/webrip.mkv");
  assert.equal(ranked[2].url, "https://example.com/4k.mkv");
});
