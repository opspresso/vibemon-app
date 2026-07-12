/**
 * Input validation functions for the Vibe Monitor
 */

const { VALID_STATES, CHARACTER_NAMES } = require('../shared/config.cjs');

// Validation limits
const PROJECT_MAX_LENGTH = 100;
const TOOL_MAX_LENGTH = 50;
const MODEL_MAX_LENGTH = 50;
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
  if (state === undefined) {
    return { valid: true, error: null };
  }
  if (!VALID_STATES.includes(state)) {
    return { valid: false, error: `Invalid state: ${state}. Valid states: ${VALID_STATES.join(', ')}` };
  }
  return { valid: true, error: null };
}

/**
 * Validate character value
 * @param {string} character
 * @returns {{valid: boolean, error: string|null}}
 */
function validateCharacter(character) {
  if (character === undefined) {
    return { valid: true, error: null };
  }
  if (!CHARACTER_NAMES.includes(character)) {
    return { valid: false, error: `Invalid character: ${character}. Valid characters: ${CHARACTER_NAMES.join(', ')}` };
  }
  return { valid: true, error: null };
}

/**
 * Validate project name
 * @param {string} project
 * @returns {{valid: boolean, error: string|null}}
 */
function validateProject(project) {
  if (project === undefined) {
    return { valid: true, error: null };
  }
  if (typeof project !== 'string') {
    return { valid: false, error: 'Project must be a string' };
  }
  if (project.length > PROJECT_MAX_LENGTH) {
    return { valid: false, error: `Project name exceeds ${PROJECT_MAX_LENGTH} characters` };
  }
  return { valid: true, error: null };
}

/**
 * Validate memory value (number 0-100)
 * @param {number} memory
 * @returns {{valid: boolean, error: string|null}}
 */
function validateMemory(memory) {
  if (memory === undefined || memory === null || memory === '') {
    return { valid: true, error: null };
  }
  if (typeof memory !== 'number') {
    return { valid: false, error: 'Memory must be a number' };
  }
  if (!Number.isInteger(memory) || memory < 0 || memory > 100) {
    return { valid: false, error: 'Memory must be an integer between 0 and 100' };
  }
  return { valid: true, error: null };
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
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    return { valid: false, error: `${label} must be an integer between 0 and 100` };
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
  if (!Number.isInteger(value) || value < 0) {
    return { valid: false, error: `${label} must be a non-negative integer` };
  }
  return { valid: true, error: null };
}

/**
 * Validate tool name
 * @param {string} tool
 * @returns {{valid: boolean, error: string|null}}
 */
function validateTool(tool) {
  if (tool === undefined || tool === '') {
    return { valid: true, error: null };
  }
  if (typeof tool !== 'string') {
    return { valid: false, error: 'Tool must be a string' };
  }
  if (tool.length > TOOL_MAX_LENGTH) {
    return { valid: false, error: `Tool name exceeds ${TOOL_MAX_LENGTH} characters` };
  }
  return { valid: true, error: null };
}

/**
 * Validate model name
 * @param {string} model
 * @returns {{valid: boolean, error: string|null}}
 */
function validateModel(model) {
  if (model === undefined || model === '') {
    return { valid: true, error: null };
  }
  if (typeof model !== 'string') {
    return { valid: false, error: 'Model must be a string' };
  }
  if (model.length > MODEL_MAX_LENGTH) {
    return { valid: false, error: `Model name exceeds ${MODEL_MAX_LENGTH} characters` };
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
  validateTool,
  validateModel,
  validateTerminalId,
  validateStatusPayload
};
