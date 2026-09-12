// Stremio core's LinkRequest / DatastoreRequest and LibraryItemState contracts:
// https://github.com/Stremio/stremio-core/tree/development/src/types
const API = "https://api.strem.io/api/";
const LINK = "https://link.stremio.com/api/v2/";

export class StremioSync {
  constructor({ configStore, fetchImpl = fetch, now = Date.now }) {
    this.configStore = configStore;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.generation = 0;
    this.pending = null;
    this.busy = false;
    this.state = "connected";
  }

  async request(url, body, signal) {
    const response = await this.fetchImpl(url, {
      method: body ? "POST" : "GET",
      headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Stremio request failed");
    const payload = await response.json();
    if (payload.error || payload.result == null) {
      const error = new Error("Stremio request failed");
      error.code = payload.error?.code;
      throw error;
    }
    return payload.result;
  }

  async status() {
    const config = await this.configStore.load();
    return { state: config.stremioAuthKey ? this.state : "disconnected" };
  }

  async connect() {
    const status = await this.status();
    if (status.state !== "disconnected") return status;
    if (this.connecting) return this.connecting;
    const generation = this.generation;
    this.connecting = (async () => {
      if (!this.pending || this.pending.expires <= this.now()) {
        const result = await this.request(`${LINK}create?type=Create`);
        const link = new URL(result.link);
        if (link.origin !== "https://link.stremio.com" || !result.code) throw new Error("Invalid link");
        if (generation !== this.generation) return { state: "disconnected" };
        this.pending = { code: result.code, link: link.href, expires: this.now() + 5 * 60_000 };
      }
      return { state: "pending", link: this.pending.link };
    })();
    try { return await this.connecting; } finally { this.connecting = null; }
  }

  async pollLink() {
    if (this.polling) return this.polling;
    const pending = this.pending;
    if (!pending) return this.status();
    if (pending.expires <= this.now()) {
      this.pending = null;
      return { state: "expired" };
    }
    const generation = this.generation;
    this.polling = (async () => {
      let result;
      try {
        result = await this.request(`${LINK}read?type=Read&code=${encodeURIComponent(pending.code)}`);
      } catch (error) {
        // The linking service returns 101 while waiting for the user, too.
        if (error.code === 101) return { state: "pending" };
        throw error;
      }
      if (typeof result.authKey !== "string" || !result.authKey || result.authKey.length > 4096) throw new Error("Invalid link response");
      if (generation !== this.generation) return { state: "disconnected" };
      await this.configStore.save({ stremioAuthKey: result.authKey });
      this.pending = null;
      this.state = "connected";
      return { state: "connected" };
    })();
    try { return await this.polling; } finally { this.polling = null; }
  }

  async disconnect() {
    this.generation++;
    this.pending = null;
    this.pendingReport = null;
    this.controller?.abort();
    await this.configStore.save({ stremioAuthKey: null });
    return { state: "disconnected" };
  }

  async report(active, progress, isCurrent = () => true) {
    const { type, id } = active?.unilinkContent ?? {};
    const { time, duration } = progress;
    if (!["movie", "series"].includes(type) || typeof id !== "string" ||
        !/^tt\d+(?::\d+:\d+)?$/.test(id) ||
        !Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0 ||
        duration > 7 * 86400 || time < 0 || time > duration + 1) return { state: "invalid" };
    if (this.busy) {
      // Keep only the latest update while the server finishes its current write.
      // This survives the browser closing after its keepalive request is accepted.
      this.pendingReport = { active, progress, isCurrent };
      return { state: "pending" };
    }
    this.busy = true;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const { stremioAuthKey: authKey } = await this.configStore.load();
      if (!authKey) return { state: "disconnected" };
      const libraryId = type === "series" ? id.split(":")[0] : id;
      const base = { authKey, collection: "libraryItem" };
      const items = await this.request(`${API}datastoreGet`, { ...base, ids: [libraryId], all: false }, controller.signal);
      if (!Array.isArray(items)) throw new Error("Invalid library response");
      let item = items.find((entry) => entry?._id === libraryId);
      if (!item) {
        // New external-playback selections may not yet exist in the library.
        const response = await this.fetchImpl(`https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(libraryId)}.json`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]), redirect: "error",
        });
        if (!response.ok) throw new Error("Metadata unavailable");
        const { meta } = await response.json();
        if (meta?.id !== libraryId || typeof meta.name !== "string") throw new Error("Invalid metadata");
        item = { _id: libraryId, type, name: meta.name, poster: meta.poster ?? null,
          posterShape: meta.posterShape ?? "poster", removed: true, temp: true,
          _ctime: new Date(this.now()).toISOString(), state: {} };
      }
      const changed = {
        ...item,
        ...(item.removed ? { temp: true } : {}),
        _mtime: new Date(this.now()).toISOString(),
        state: {
          timeWatched: 0, overallTimeWatched: 0, timesWatched: 0, flaggedWatched: 0,
          ...item.state,
          timeOffset: Math.round(Math.min(time, duration) * 1000),
          duration: Math.round(duration * 1000), video_id: id,
          lastWatched: new Date(this.now()).toISOString(),
        },
      };
      if (generation !== this.generation || controller.signal.aborted || !isCurrent()) return { state: "stale" };
      const result = await this.request(`${API}datastorePut`, { ...base, changes: [changed] }, controller.signal);
      if (result.success !== true) throw new Error("Progress not saved");
      this.state = "synced";
      return { state: "synced" };
    } catch {
      this.state = "error";
      return { state: "error" };
    } finally {
      this.busy = false;
      if (this.controller === controller) this.controller = null;
      if (this.pendingReport) {
        const next = this.pendingReport;
        this.pendingReport = null;
        void this.report(next.active, next.progress, next.isCurrent);
      }
    }
  }
}
