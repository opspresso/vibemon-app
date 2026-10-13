const { validateStatusPayload } = require('../modules/validators.cjs');

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
    const projectId = state.project ? sourceId ? `cloud:${sourceId}` : state.project : null;
    const response = { success: true, project: projectId, state: state.state, focusedProject: this.windowManager.getFocusedProjectId() };
    if (!projectId) return { valid: true, response: { ...response, skipped: true } };

    const routed = preserveFocus
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
}
module.exports = { StatusIngress };
