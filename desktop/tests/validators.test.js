/**
 * Tests for validators.cjs
 */

const {
  validateState,
  validateCharacter,
  validateProject,
  validateMemory,
  validateUsage,
  validateTool,
  validateModel,
  validateStatusPayload
} = require('../modules/validators.cjs');

describe('validateState', () => {
  test('accepts undefined state', () => {
    const result = validateState(undefined);
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  test('accepts valid states', () => {
    const validStates = ['start', 'idle', 'thinking', 'planning', 'working', 'notification', 'done', 'sleep'];
    validStates.forEach(state => {
      const result = validateState(state);
      expect(result.valid).toBe(true);
      expect(result.error).toBeNull();
    });
  });

  test('rejects invalid state', () => {
    const result = validateState('invalid');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid state');
  });
});

describe('validateCharacter', () => {
  test('accepts undefined character', () => {
    const result = validateCharacter(undefined);
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  test('accepts valid characters', () => {
    const validCharacters = ['clawd', 'codex', 'kiro', 'claw'];
    validCharacters.forEach(character => {
      const result = validateCharacter(character);
      expect(result.valid).toBe(true);
      expect(result.error).toBeNull();
    });
  });

  test('rejects invalid character', () => {
    const result = validateCharacter('invalid');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid character');
  });
});

describe('validateProject', () => {
  test('accepts undefined project', () => {
    const result = validateProject(undefined);
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  test('accepts valid project name', () => {
    const result = validateProject('my-project');
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  test('rejects non-string project', () => {
    const result = validateProject(123);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('must be a string');
  });

  test('rejects too long project name', () => {
    const longName = 'a'.repeat(101);
    const result = validateProject(longName);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('exceeds');
  });
});

describe('validateMemory', () => {
  test('accepts undefined memory', () => {
    const result = validateMemory(undefined);
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  test('accepts null memory', () => {
    const result = validateMemory(null);
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  test('accepts empty string memory', () => {
    const result = validateMemory('');
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  test('accepts valid memory values', () => {
    const validMemories = [0, 50, 100, 1, 99];
    validMemories.forEach(memory => {
      const result = validateMemory(memory);
      expect(result.valid).toBe(true);
      expect(result.error).toBeNull();
    });
  });

  test('rejects non-number memory', () => {
    const result = validateMemory('50%');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('must be a number');
  });

  test('rejects memory over 100', () => {
    const result = validateMemory(101);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('0 and 100');
  });

  test('rejects negative memory', () => {
    const result = validateMemory(-1);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('0 and 100');
  });

  test('rejects non-integer memory', () => {
    const result = validateMemory(50.5);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('integer');
  });
});

describe('validateUsage', () => {
  test('accepts undefined/null/empty', () => {
    [undefined, null, ''].forEach(value => {
      expect(validateUsage(value, 'usage5h').valid).toBe(true);
    });
  });

  test('accepts valid usage values', () => {
    [0, 36, 100].forEach(value => {
      expect(validateUsage(value, 'usage5h').valid).toBe(true);
    });
  });

  test('rejects out-of-range and non-integer values', () => {
    [101, -1, 12.5].forEach(value => {
      expect(validateUsage(value, 'usageWeek').valid).toBe(false);
    });
  });

  test('includes the field label in errors', () => {
    const result = validateUsage('50%', 'usageWeek');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('usageWeek');
  });
});

describe('validateTool', () => {
  test('accepts undefined tool', () => {
    const result = validateTool(undefined);
    expect(result.valid).toBe(true);
  });

  test('accepts empty string tool', () => {
    const result = validateTool('');
    expect(result.valid).toBe(true);
  });

  test('accepts valid tool name', () => {
    const result = validateTool('Bash');
    expect(result.valid).toBe(true);
  });

  test('rejects non-string tool', () => {
    const result = validateTool(123);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('must be a string');
  });

  test('rejects too long tool name', () => {
    const result = validateTool('a'.repeat(51));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('exceeds');
  });
});

describe('validateModel', () => {
  test('accepts undefined model', () => {
    const result = validateModel(undefined);
    expect(result.valid).toBe(true);
  });

  test('accepts valid model name', () => {
    const result = validateModel('claude-opus-4.5');
    expect(result.valid).toBe(true);
  });

  test('rejects non-string model', () => {
    const result = validateModel(123);
    expect(result.valid).toBe(false);
  });

  test('rejects too long model name', () => {
    const result = validateModel('a'.repeat(51));
    expect(result.valid).toBe(false);
  });
});

describe('validateStatusPayload', () => {
  test('accepts valid payload', () => {
    const result = validateStatusPayload({
      state: 'thinking',
      character: 'clawd',
      project: 'my-project',
      memory: 50
    });
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  test('accepts empty payload', () => {
    const result = validateStatusPayload({});
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  test('rejects invalid state in payload', () => {
    const result = validateStatusPayload({
      state: 'invalid'
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid state');
  });

  test('rejects invalid character in payload', () => {
    const result = validateStatusPayload({
      character: 'invalid'
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid character');
  });

  test('rejects invalid memory in payload', () => {
    const result = validateStatusPayload({
      memory: 150
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('0 and 100');
  });

  test('accepts payload with usage5h and usageWeek', () => {
    const result = validateStatusPayload({
      state: 'working',
      character: 'clawd',
      project: 'my-project',
      memory: 50,
      usage5h: 36,
      usageWeek: 37
    });
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });

  test('rejects invalid usage in payload', () => {
    const result = validateStatusPayload({
      usage5h: 150
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('usage5h');
  });

  test('accepts payload with tool, model', () => {
    const result = validateStatusPayload({
      state: 'working',
      tool: 'Bash',
      model: 'claude-opus-4.5'
    });
    expect(result.valid).toBe(true);
  });

  test('rejects invalid tool in payload', () => {
    const result = validateStatusPayload({
      tool: 123
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Tool');
  });
});
