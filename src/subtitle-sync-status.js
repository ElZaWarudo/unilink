// Live player telemetry only: automatic timing must never become a saved manual delay.
export class SubtitleSyncStatus {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.reports = new Map();
  }

  prune() {
    const cutoff = this.now() - 15000;
    for (const [id, report] of this.reports) {
      if (report.updatedAt <= cutoff) this.reports.delete(id);
    }
  }

  record(active, subtitleUrl, body) {
    this.prune();
    const previous = this.reports.get(body.clientId);
    if (previous && body.sequence <= previous.sequence) return false;
    this.reports.delete(body.clientId);
    while (this.reports.size >= 32) this.reports.delete(this.reports.keys().next().value);
    this.reports.set(body.clientId, { ...body, active, subtitleUrl, updatedAt: this.now() });
    return true;
  }

  get(active, subtitleUrl) {
    this.prune();
    let latest;
    for (const [id, report] of this.reports) {
      if (report.active !== active || report.subtitleUrl !== subtitleUrl) this.reports.delete(id);
      else latest = report;
    }
    if (!latest) return null;
    const manualBaseline = latest.enabled ? latest.manualBaseline : 0;
    const automaticOffset = latest.enabled ? latest.automaticOffset : 0;
    const manualAdjustment = (active.playbackSettings?.subtitleDelay ?? 0) - manualBaseline;
    return { enabled: latest.enabled, state: latest.state, automaticOffset, manualBaseline,
      manualAdjustment, effectiveDelay: automaticOffset + manualAdjustment,
      time: latest.time, updatedAt: latest.updatedAt };
  }
}
