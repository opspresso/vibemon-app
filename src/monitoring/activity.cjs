const { companionState } = require('../shared/monitoring/state.cjs');

// Polls may change a source's presentation without a new event timestamp.
class CloudActivity {
  constructor(update, remove, now = Date.now, isLocal = () => false) {
    this.update = update;
    this.remove = remove;
    this.now = now;
    this.isLocal = isLocal;
    this.seen = new Map();
  }

  accept(sources) {
    const now = this.now();
    const agents = sources.filter(source => source.kind === 'agent' && source.agent);
    const selected = new Set(agents.map(source => source.sourceId));
    for (const id of this.seen.keys()) {
      if (!selected.has(id)) { this.remove(`cloud:${id}`); this.seen.delete(id); }
    }
    for (const source of agents) {
      const previous = this.seen.get(source.sourceId);
      // Hooks on this device deliver the same events locally, sooner and with
      // terminal routing. A cloud copy would compete with them for the companion.
      if (this.isLocal(source.sourceId)) {
        if (previous) { this.remove(`cloud:${source.sourceId}`); this.seen.delete(source.sourceId); }
        continue;
      }
      // Agent sources are never stale: sleep means the event clock has expired.
      const state = companionState(source, now);
      const inactive = state === 'sleep';
      if (inactive && !previous) continue;
      if (previous?.observedAt === source.observedAt && previous.state === state) continue;
      // A heartbeat repeats a running turn; it refreshes the clock but is not
      // new activity, so it does not compete for the companion.
      const activity = !inactive && !source.heartbeat && previous?.observedAt !== source.observedAt;
      this.seen.set(source.sourceId, { observedAt: source.observedAt, state });
      const data = { ...source.agent, state };
      for (const [metric, field] of [['contextPercent', 'memory'], ['usageSessionPercent', 'usage5h'], ['usageWeekPercent', 'usageWeek']]) {
        if (typeof source.metrics[metric] === 'number') data[field] = source.metrics[metric];
      }
      this.update(data, source.sourceId, { activity });
    }
  }
}
module.exports = { CloudActivity };
