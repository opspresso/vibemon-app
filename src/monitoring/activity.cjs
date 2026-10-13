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
      if (sourceStale(source, now) && !this.seen.has(source.sourceId)) continue;
      const state = companionState(source, now);
      const key = `${source.observedAt}:${state}`;
      if (this.seen.get(source.sourceId) === key) continue;
      this.seen.set(source.sourceId, key);
      const data = { ...source.agent, state };
      for (const [metric, field] of [['contextPercent', 'memory'], ['usageSessionPercent', 'usage5h'], ['usageWeekPercent', 'usageWeek']]) {
        if (typeof source.metrics[metric] === 'number') data[field] = Math.round(source.metrics[metric]);
      }
      this.update(data, source.sourceId);
    }
  }
}
module.exports = { CloudActivity };
