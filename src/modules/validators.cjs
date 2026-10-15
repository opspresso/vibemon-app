/**
 * Input validation functions for the Vibe Monitor
 */

const { VALID_STATES, OBSERVATION_MAX_AGE_MS, OBSERVATION_CLOCK_SKEW_MS } = require('../shared/config.cjs');
const { validId, validAccountId } = require('../monitoring/domain.cjs');
const { validPercentage, validText, AGENT_TEXT_LIMITS } = require('../shared/resource-schema.cjs');

// Local hook payload limits. Cloud source validation lives in
// monitoring/domain.cjs and uses the cloud API's source contract.
const { project: PROJECT_MAX_LENGTH, tool: TOOL_MAX_LENGTH, model: MODEL_MAX_LENGTH, character: CHARACTER_MAX_LENGTH } = AGENT_TEXT_LIMITS;
const TERMINAL_ID_MAX_LENGTH = 100;
// Memory is now a number (0-100), not a string
// iTerm2: iterm2:w0t0p0:UUID format, Ghostty: ghostty:PID format
const ITERM2_SESSION_PATTERN = /^iterm2:w\d+t\d+p\d+:[0-9A-Fa-f-]{36}$/;
const GHOSTTY_PID_PATTERN = /^ghostty:\d{1,10}$/;

/**
 * Validate state value
 * @param {string} state
 * @returns {{valid: boolean, error: string|null}}
 */
function validateState(state) {
  // Required, matching the cloud API (POST /api/status rejects a missing
  // state): a state-less update has nothing to display, would take focus
  // while rendering as idle, and never gets a state timeout — so it would
  // linger in the registry forever.
  if (state === undefined) {
    return { valid: false, error: 'state is required' };
  }
  if (typeof state !== 'string') return { valid: false, error: 'State must be a string' };
  if (!validText(state, AGENT_TEXT_LIMITS.state)) return { valid: false, error: 'State must be single-line Unicode text' };
  if (!VALID_STATES.includes(state)) {
    return { valid: false, error: `Invalid state: ${state}. Valid states: ${VALID_STATES.join(', ')}` };
  }
  return { valid: true, error: null };
}

/**
 * Build a validator for an optional single-line text field.
 * @param {string} name - the field name used in error messages
 * @param {number} maxLength
 * @returns {(value: unknown) => {valid: boolean, error: string|null}}
 */
function optionalText(name, maxLength) {
  return (value) => {
    if (value === undefined || value === '') return { valid: true, error: null };
    if (typeof value !== 'string') return { valid: false, error: `${name} must be a string` };
    if (value.length > maxLength) return { valid: false, error: `${name} exceeds ${maxLength} characters` };
    if (!validText(value, maxLength, true)) return { valid: false, error: `${name} must be single-line Unicode text` };
    return { valid: true, error: null };
  };
}

// Names outside CHARACTER_NAMES pass here; state-manager normalizes them to
// DEFAULT_CHARACTER, so a bridge that sends a removed character still reports.
const validateCharacter = optionalText('Character name', CHARACTER_MAX_LENGTH);
const validateProject = optionalText('Project name', PROJECT_MAX_LENGTH);
const validateTool = optionalText('Tool name', TOOL_MAX_LENGTH);
const validateModel = optionalText('Model name', MODEL_MAX_LENGTH);
const validateUsageLabel = optionalText('usageWeekModelLabel', AGENT_TEXT_LIMITS.usageWeekModelLabel);
/**
 * Validate memory value (number 0-100)
 * @param {number} memory
 * @returns {{valid: boolean, error: string|null}}
 */
function validateMemory(memory) {
  return validateUsage(memory, 'Memory');
}

/**
 * Validate a plan-usage percentage (number 0-100)
 * @param {number} value
 * @param {string} label - Field name for error messages
 * @returns {{valid: boolean, error: string|null}}
 */
function validateUsage(value, label) {
  if (value === undefined || value === null || value === '') {
    return { valid: true, error: null };
  }
  if (typeof value !== 'number') {
    return { valid: false, error: `${label} must be a number` };
  }
  if (!validPercentage(value)) {
    return { valid: false, error: `${label} must be a finite number between 0 and 100` };
  }
  return { valid: true, error: null };
}

/**
 * Validate minutes remaining until a usage quota resets (non-negative integer)
 * @param {number} value
 * @param {string} label - Field name for error messages
 * @returns {{valid: boolean, error: string|null}}
 */
function validateResetMinutes(value, label) {
  if (value === undefined || value === null || value === '') {
    return { valid: true, error: null };
  }
  if (typeof value !== 'number') {
    return { valid: false, error: `${label} must be a number` };
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    return { valid: false, error: `${label} must be a non-negative integer` };
  }
  return { valid: true, error: null };
}

/**
 * Validate terminal ID (iTerm2 session or Ghostty PID)
 * @param {string} terminalId
 * @returns {{valid: boolean, error: string|null}}
 */
function validateTerminalId(terminalId) {
  if (terminalId === undefined || terminalId === null || terminalId === '') {
    return { valid: true, error: null };
  }
  if (typeof terminalId !== 'string') {
    return { valid: false, error: 'terminalId must be a string' };
  }
  if (terminalId.length > TERMINAL_ID_MAX_LENGTH) {
    return { valid: false, error: `terminalId exceeds ${TERMINAL_ID_MAX_LENGTH} characters` };
  }
  // Accept iTerm2 session format or Ghostty PID format
  if (!ITERM2_SESSION_PATTERN.test(terminalId) && !GHOSTTY_PID_PATTERN.test(terminalId)) {
    return { valid: false, error: 'terminalId must be a valid iTerm2 session ID or Ghostty PID' };
  }
  return { valid: true, error: null };
}

/**
 * Validate status payload
 * @param {object} data
 * @returns {{valid: boolean, error: string|null}}
 */
function validateStatusPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, error: 'Payload must be a JSON object' };
  }
  if (data.sourceId !== undefined && !validId(data.sourceId)) return { valid: false, error: 'Invalid sourceId' };
  if (data.account !== undefined) {
    const account = data.account;
    if (!account || typeof account !== 'object' || Array.isArray(account) ||
        Object.keys(account).some(key => !['id', 'provider', 'displayName'].includes(key)) ||
        typeof account.provider !== 'string' || typeof account.id !== 'string' ||
        !validAccountId(`${account.provider}:${account.id}`) ||
        !validText(account.displayName, 128)) {
      return { valid: false, error: 'Invalid account identity' };
    }
  }
  if (data.heartbeat !== undefined && typeof data.heartbeat !== 'boolean') {
    return { valid: false, error: 'heartbeat must be a boolean' };
  }
  if (data.observedAt !== undefined) {
    const now = Date.now();
    const time = typeof data.observedAt === 'string' ? Date.parse(data.observedAt) : NaN;
    if (!Number.isFinite(time) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(data.observedAt) || time < now - OBSERVATION_MAX_AGE_MS || time > now + OBSERVATION_CLOCK_SKEW_MS) {
      return { valid: false, error: 'observedAt must be a recent UTC timestamp' };
    }
  }

  const stateResult = validateState(data.state);
  if (!stateResult.valid) return stateResult;

  const characterResult = validateCharacter(data.character);
  if (!characterResult.valid) return characterResult;

  const projectResult = validateProject(data.project);
  if (!projectResult.valid) return projectResult;

  const memoryResult = validateMemory(data.memory);
  if (!memoryResult.valid) return memoryResult;

  const usage5hResult = validateUsage(data.usage5h, 'usage5h');
  if (!usage5hResult.valid) return usage5hResult;

  const usageWeekResult = validateUsage(data.usageWeek, 'usageWeek');
  if (!usageWeekResult.valid) return usageWeekResult;

  const usage5hResetsInResult = validateResetMinutes(data.usage5hResetsIn, 'usage5hResetsIn');
  if (!usage5hResetsInResult.valid) return usage5hResetsInResult;

  const usageWeekResetsInResult = validateResetMinutes(data.usageWeekResetsIn, 'usageWeekResetsIn');
  if (!usageWeekResetsInResult.valid) return usageWeekResetsInResult;

  const usageWeekModelResult = validateUsage(data.usageWeekModel, 'usageWeekModel');
  if (!usageWeekModelResult.valid) return usageWeekModelResult;

  const usageWeekModelResetsInResult = validateResetMinutes(
    data.usageWeekModelResetsIn, 'usageWeekModelResetsIn'
  );
  if (!usageWeekModelResetsInResult.valid) return usageWeekModelResetsInResult;

  const usageWeekModelLabelResult = validateUsageLabel(data.usageWeekModelLabel);
  if (!usageWeekModelLabelResult.valid) return usageWeekModelLabelResult;

  const toolResult = validateTool(data.tool);
  if (!toolResult.valid) return toolResult;

  const modelResult = validateModel(data.model);
  if (!modelResult.valid) return modelResult;

  const terminalIdResult = validateTerminalId(data.terminalId);
  if (!terminalIdResult.valid) return terminalIdResult;

  return { valid: true, error: null };
}

module.exports = {
  validateState,
  validateCharacter,
  validateProject,
  validateMemory,
  validateUsage,
  validateResetMinutes,
  validateUsageLabel,
  validateTool,
  validateModel,
  validateTerminalId,
  validateStatusPayload
};
