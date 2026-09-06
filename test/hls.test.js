import assert from "node:assert/strict";
import test from "node:test";
import { HLS_RESOURCE, rewritePlaylist, audioTracksFromPlaylist, selectPlaylistAudio } from "../src/hls.js";

test("permite elegir audio en televisores sin AudioTrack API", () => {
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Original",LANGUAGE="spa",DEFAULT=YES,URI="audio0.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Dub",LANGUAGE="eng",DEFAULT=NO,URI="audio1.m3u8"\n#EXT-X-STREAM-INF:AUDIO="audio"\nvideo0.m3u8';
  assert.deepEqual(audioTracksFromPlaylist(master), [{ name: "Original", lang: "spa", default: true }, { name: "Dub", lang: "eng", default: false }]);
  const selected = selectPlaylistAudio(master, 1);
  assert.doesNotMatch(selected, /audio0.m3u8/);
  assert.match(selected, /DEFAULT=YES,URI="audio1.m3u8"/);
  assert.match(selected, /video0.m3u8/);
  assert.throws(() => selectPlaylistAudio(master, 3));
});

test("reescribe segmentos e inicialización manteniendo tiempos y duración", () => {
  const playlist = '#EXTM3U\n#EXT-X-MAP:URI="audio0/init.mp4?mediaURL=private"\n#EXTINF:4.096,\naudio0/segment0.m4s?mediaURL=private\n#EXT-X-ENDLIST\n';
  assert.equal(rewritePlaylist(playlist, new URL("http://127.0.0.1:11470/hlsv2/id/audio0.m3u8"), "/hls/session/1/"), '#EXTM3U\n#EXT-X-MAP:URI="/hls/session/1/audio0/init.mp4"\n#EXTINF:4.096,\n/hls/session/1/audio0/segment0.m4s\n#EXT-X-ENDLIST\n');
});

test("impide traversal, orígenes externos y operaciones del convertidor", () => {
  for (const value of ["../master.m3u8", "https://evil.test/audio0.m3u8", "//evil.test/audio0.m3u8", "burn", "probe", "audio0/../../master.m3u8"]) {
    assert.throws(() => rewritePlaylist(`#EXTM3U\n${value}`, new URL("http://127.0.0.1:11470/hlsv2/id/master.m3u8"), "/hls/session/1/"));
  }
  assert.equal(HLS_RESOURCE.test("audio0/segment2.m4s"), true);
  assert.equal(HLS_RESOURCE.test("audio0/segment-1.m4s"), false);
});
