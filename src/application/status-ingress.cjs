const { validateStatusPayload } = require('../modules/validators.cjs');
const { CloudActivity } = require('../monitoring/activity.cjs');

// HTTP and cloud adapters share this use case. Window/timer effects stay behind ports.
class StatusIngress {
  constructor(stateManager, windowManager, { onProjectSwitched = () => {}, onStateUpdate = () => {} } = {}) {
    Object.assign(this, { stateManager, windowManager, onProjectSwitched, onStateUpdate });
  }

  accept(data, { sourceId, preserveFocus = false } = {}) {
    const validation = validateStatusPayload(data);
    if (!validation.valid) return validation;
    const normalized = this.stateManager.validateStateData(data);
    if (!normalized.valid) return { valid: false, error: normalized.error || 'Invalid state data' };
    const state = normalized.data;
    const projectId = state.project && state.project !== '.vibemon' ? sourceId ? `cloud:${sourceId}` : state.sourceId ? `local:${state.sourceId}` : state.project : null;
    const response = { success: true, project: projectId, state: state.state, focusedProject: this.windowManager.getFocusedProjectId() };
    if (!projectId) return { valid: true, response: { ...response, skipped: true } };
    if (!sourceId && state.sourceId) {
      const previous = this.windowManager.getRegisteredState(projectId);
      const identity = value => value?.account ? `${value.account.provider}:${value.account.id}` : null;
      if (previous && identity(previous) !== identity(state)) return { valid: false, error: 'sourceId already belongs to another account' };
      if (data.observedAt && previous?.observedAt && Date.parse(state.observedAt) <= Date.parse(previous.observedAt)) {
        return { valid: true, response: { ...response, skipped: true, reason: 'duplicate_or_older' } };
      }
      // The same source may have reached the companion through a cloud poll
      // first; local delivery now owns it, including the window if focused.
      this.forget(`cloud:${state.sourceId}`);
    }

    // A heartbeat repeats a running turn's state: it refreshes the lifecycle
    // timer like any report but is not new activity, so it never takes focus.
    const routed = preserveFocus || data.heartbeat === true
      ? this.windowManager.routeStatusUpdate(projectId, state, { preserveFocus: true })
      : this.windowManager.routeStatusUpdate(projectId, state);
    if (routed.switchedProject) this.onProjectSwitched(routed.switchedProject);
    // Unchanged and background events still refresh their lifecycle timer.
    if (sourceId) this.stateManager.setupStateTimeout(projectId, state.state, { remote: true });
    else this.stateManager.setupStateTimeout(projectId, state.state);
    response.focusedProject = this.windowManager.getFocusedProjectId();
    if (!routed.updateResult.updated) return { valid: true, response: { ...response, skipped: true } };
    if (routed.updateResult.stateChanged) {
      this.windowManager.updateAlwaysOnTopByState(state.state);
      this.onStateUpdate(false);
    }
    this.windowManager.sendToWindow(projectId, 'state-update', routed.stateData);
    return { valid: true, response };
  }

  // New cloud events compete for focus like local events; clock re-evaluations
  // do not. Sources this device reports locally are left to local delivery.
  cloudActivity(now) {
    return new CloudActivity((data, sourceId, { activity }) => {
      const result = this.accept(data, { sourceId, preserveFocus: !activity });
      if (!result.valid) console.error('cloud invalid payload:', result.error);
    }, projectId => {
      // A deleted, deselected, or disconnected source closes the companion only when followed.
      this.forget(projectId);
      if (this.windowManager.getWindow(projectId)) this.windowManager.closeWindow(projectId);
    }, now, id => Boolean(this.windowManager.getRegisteredState(`local:${id}`)));
  }

  forget(projectId) {
    this.stateManager.cleanupProject(projectId);
    this.windowManager.removeProject(projectId, { forgetLastState: true });
  }
}
module.exports = { StatusIngress };
