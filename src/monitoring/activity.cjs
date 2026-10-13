const { companionState, sourceStale } = require('../shared/monitoring/state.cjs');

// Polls may change a source's presentation without a new event timestamp.
class CloudActivity {
  constructor(update, remove, now = Date.now) {
    this.update = update;
    this.remove = remove;
    this.now = now;
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
      if (sourceStale(source, now) && !previous) continue;
      const state = companionState(source, now);
      if (previous?.observedAt === source.observedAt && previous.state === state) continue;
      const activity = !sourceStale(source, now) && previous?.observedAt !== source.observedAt;
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
