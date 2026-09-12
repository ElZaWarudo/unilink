# Unilink

Unilink lets you start playback in Stremio and continue watching from a web
browser on another device connected to the same local network.

It adds compact **Unilink** entries to Torrentio results,
keeps a stable browser URL for the current selection, and runs quietly from the
system tray. The desktop application is built with
[Tauri](https://tauri.app/) and includes the local server, so end users do not
need Node.js or a terminal.

> [!IMPORTANT]
> Unilink does not download or transcode media by itself. It reuses the local
> Stremio streaming server and should only be used with content you are legally
> allowed to access.

## Features

- Native system tray application for Windows and Linux.
- Guided Torrentio configuration on first launch.
- Start, stop, restart, configure, and quit controls from the tray menu.
- A stable `/watch` page for phones, tablets, TVs, and other computers.
- Automatic subtitle discovery through OpenSubtitles v3.
- Subtitle language, source, and timing preferences persisted between sessions.
- Optional local speech matching to synchronize English subtitles with English audio.
- Resume position and touch-friendly playback controls.
- Optional one-time Stremio account connection with automatic playback-position sync.
- HTTP Range proxying for seeking.
- Automatic next-episode queue for standard Stremio IMDb episode IDs.
- Source ranking based on resolution, release, video, and audio similarity.
- Configurable LAN address, port, Stremio server, and metadata provider.

## Requirements

### End users

- Windows 10 or later, or a Linux desktop with AppIndicator support.
- Stremio Desktop running on the same computer as Unilink.
- Torrentio installed, or a configured Torrentio manifest URL.
- Both playback devices connected to the same local network.

Some GNOME environments require an AppIndicator extension before tray icons
are visible.

### Development

- Node.js 20 or later.
- Rust and Cargo.
- The native dependencies required by Tauri 2.

On Windows, install Visual Studio Build Tools with **Desktop development with
C++** and a Windows SDK.

On Debian or Ubuntu:

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

## Getting started

Install the native package for your operating system and launch Unilink. On the
first run, it opens the configuration page automatically. Later launches stay
in the background and can be controlled from the tray icon.

Unilink uses the following addresses by default:

```text
Configure Torrentio: http://127.0.0.1:17891/configure
Install the add-on:   http://127.0.0.1:17891/manifest.json
Second screen:        http://YOUR-COMPUTER-IP:17891/watch
```

1. Open the configuration page on the computer running Unilink.
2. Paste the complete URL of your configured Torrentio manifest and save it.
3. Install `http://127.0.0.1:17891/manifest.json` in Stremio.
4. Open a movie or episode and select a result beginning with **Unilink**.
5. Open the second-screen URL from a browser on another device.

The torrent starts when the browser requests `/media`. Selecting another result
in Stremio updates the content served by the same `/watch` address.

## English subtitle synchronization

Open **Configuración** from the tray on the host PC. Under **Sincronización por
voz**, choose **Instalar motor de inglés**. The page reports installation progress
and offers a retry if it fails. Existing installations are detected automatically.
The desktop package does not require Node.js or a source checkout for this step.
Developers can also run `npm run setup:subtitle-sync` from the checkout.

Setup requires Python 3.10 or newer and downloads the English `base.en` model and
its Python dependencies. Installation needs Internet access and stops after
20 minutes if it cannot finish; retry resumes reusable downloads. Windows uses
Stremio's bundled FFmpeg and FFprobe; on
Linux install both commands on `PATH`. Custom installations can set
`UNILINK_FFMPEG`, `UNILINK_FFPROBE`, `UNILINK_SETUP_PYTHON`, and
`UNILINK_SUBTITLE_SYNC_HOME` (default `~/.unilink/subtitle-sync`).

Select English subtitles and English audio, then enable **Auto-sync inglés** in
the player. For tracks without language metadata, enable it only when the audio
is English. Each screen opts in separately. The host analyzes up to two minutes
of audio around playback and matches spoken phrases with the selected subtitles.
Audio and recognized words stay on the host; playback does not wait for analysis.

Corrections apply only within sections supported by at least six consistent
phrase matches. Music, paraphrased subtitles, and uncertain matches can leave a
section unchanged. The player analyzes later sections as playback advances;
seeking or changing tracks discards pending work. Manual subtitle delay remains
additive, and switching auto-sync off restores the original cue timings.
The first correction can take around a minute on a laptop CPU. This is local
phrase timing, not a guarantee of frame-accurate alignment across an episode.

## Playback recovery

The player keeps its controls visible while paused or after a playback failure.
Use **Reintentar subtítulos** to recover a failed subtitle download without
restarting the video. Local resume status and Stremio account status are reported
separately; account linking is optional.

Queue edits show pending state and retain keyboard focus. **Deshacer última
eliminación** restores the last removed episode until another source is selected.
An old player or settings tab cannot update a newer viewing session.

## Tray application

The tray menu provides shortcuts to:

- inspect the server status;
- configure or install the Stremio add-on;
- open or copy the second-screen URL;
- start, stop, or restart the local server;
- quit Unilink completely.

Unilink does not register itself to start with the operating system. It runs
only after the user launches it and stops when **Quit Unilink** is selected.

## Playback and episode queue

Double-tap the left half of the video to rewind ten seconds or the right half to
skip forward ten seconds. In fullscreen mode, controls disappear after three
seconds of inactivity and can be toggled by tapping the video.

For standard Stremio episode IDs in the form
`tt...:season:episode`, Unilink:

- loads series metadata and displays a queue on `/watch`;
- prepares up to five episodes and three alternative sources per episode;
- prioritizes sources similar to the current one;
- lets the viewer reorder or remove queued episodes;
- starts the next episode after a cancellable ten-second countdown;
- remembers the **Stop after this episode** preference.

Missing metadata or sources do not interrupt the current episode. The queue
shows which item could not be prepared.

### Save progress in Stremio

On the PC, open **Configure** from the tray and click **Conectar Stremio**.
Approve the connection on Stremio's website; Unilink detects it automatically.
You only need to do this once. Use **Desconectar** to remove Unilink's saved connection.

While watching, Unilink sends the current movie or episode position to your
Stremio account every 15 seconds and on pause or exit. The player shows whether
the position was saved or is waiting to retry. Playback and browser-local resume
continue working if Stremio is unavailable. Closing the browser while offline
can leave Stremio at the last successfully saved position.

This synchronizes playback position from Unilink to Stremio. It preserves existing
watched markers; it does not mark completed episodes watched or import account
resume positions into a different browser. Stremio may need to refresh its library
before displaying an external update.

The account session key stays in the PC's Unilink configuration file and is never
sent to playback devices. Treat that file as private. Linux creates it with
owner-only permissions; Windows uses the data directory's inherited permissions.
Connecting and disconnecting are available only from the PC. You may need to
connect again if Stremio revokes the session.

## Configuration

The server can also be run directly for development:

```bash
npm install
npm start
```

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `UNILINK_PORT` | `17891` | HTTP port used by Unilink. |
| `UNILINK_LAN_HOST` | Auto-detected | LAN address advertised to other devices. |
| `STREMIO_SERVER_URL` | `http://127.0.0.1:11470` | Local Stremio streaming server. |
| `UNILINK_METADATA_MANIFEST_URL` | Cinemeta v3 | Stremio-compatible metadata add-on. |
| `UNILINK_DATA_DIR` | Platform-specific | Directory used for persistent configuration. |

PowerShell example:

```powershell
$env:UNILINK_LAN_HOST = "192.168.1.50"
$env:UNILINK_PORT = "17891"
npm start
```

## Development

Install dependencies:

```bash
npm install
```

Run the Tauri tray application:

```powershell
# Windows
.\start-unilink.cmd
```

```bash
# Linux
chmod +x start-unilink.sh
./start-unilink.sh
```

Build the native package for the current operating system:

```bash
npm run build:desktop
```

Tauri generates Windows installers when built on Windows and Linux packages
when built on Linux. Linux packages must be produced on a Linux system.

Run the checks:

```bash
npm test
npm run check

cd src-tauri
cargo test
```

The test suite covers configuration persistence, Torrentio and OpenSubtitles
requests, stream decoration, subtitle preferences, episode ranking and queues,
activation, LAN address selection, HTTP Range proxying, and Tauri onboarding.

## Project structure

```text
desktop/       Minimal Tauri frontend
scripts/       Sidecar packaging tools
src/           Node.js local server
src-tauri/     Native tray application
test/          Node.js test suite
```

## Compatibility and security notes

- Browser playback uses Stremio's HLS v2 service to package video and prepare
  AAC stereo audio, including sources with Dolby Digital Plus / E-AC-3 audio.
  Stremio copies compatible video and may convert unsupported video codecs.
- Use **Audio** beside the volume control to select an embedded language or
  alternate soundtrack. The browser remembers the language and track name;
  each screen chooses independently. A source with one track shows that track
  with the selector disabled. HLS.js is bundled locally, with native HLS as a
  fallback. Native players receive a playlist containing the chosen track,
  preserving the playback position when switching audio.
- An up-to-date Stremio Desktop must remain open to serve torrents, prepare HLS
  playback, and convert subtitle tracks to WebVTT. If preparation fails, the
  player offers **Reintentar** rather than falling back to potentially silent
  playback. The browser must support MediaSource or native HLS.
- `/media` remains available as the original, unconverted stream. HLS URLs are
  tied to the active source and server instance; stale URLs return HTTP 409.
- The `/watch` page has no authentication and is intended only for trusted local
  networks.
- Do not expose port `17891` to the Internet or configure router port
  forwarding for it.
- Configuration and activation endpoints accept connections only from the
  computer running Unilink.
- If Windows Firewall prompts for access, allow Unilink only on private
  networks.
