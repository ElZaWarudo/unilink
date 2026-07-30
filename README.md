# Unilink

Unilink lets you start playback in Stremio and continue watching from a web
browser on another device connected to the same local network.

It adds **Servir en red** ("Serve over network") entries to Torrentio results,
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
- Resume position and touch-friendly playback controls.
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
4. Open a movie or episode and select a result beginning with
   **Servir en red** ("Serve over network").
5. Open the second-screen URL from a browser on another device.

The torrent starts when the browser requests `/media`. Selecting another result
in Stremio updates the content served by the same `/watch` address.

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

- Unilink does not transcode. The browser must support the source container and
  codecs. MP4 with H.264/AAC generally offers the broadest compatibility.
- Stremio Desktop must remain open to serve the torrent and convert subtitle
  tracks to WebVTT.
- The `/watch` page has no authentication and is intended only for trusted local
  networks.
- Do not expose port `17891` to the Internet or configure router port
  forwarding for it.
- Configuration and activation endpoints accept connections only from the
  computer running Unilink.
- If Windows Firewall prompts for access, allow Unilink only on private
  networks.
