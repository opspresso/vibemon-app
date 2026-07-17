/**
 * ESLint flat config for VibeMon
 */

const nodeGlobals = {
  require: 'readonly',
  module: 'readonly',
  exports: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  process: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  Buffer: 'readonly',
  fetch: 'readonly',
  AbortSignal: 'readonly'
};

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  URL: 'readonly',
  Image: 'readonly',
  HTMLCanvasElement: 'readonly'
};

const jestGlobals = {
  describe: 'readonly',
  test: 'readonly',
  expect: 'readonly',
  beforeEach: 'readonly',
  afterEach: 'readonly',
  beforeAll: 'readonly',
  afterAll: 'readonly',
  jest: 'readonly'
};

const commonRules = {
  // Error prevention
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  'no-undef': 'error',
  'no-const-assign': 'error',
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-empty': 'warn',
  'no-extra-semi': 'warn',
  'no-unreachable': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',

  // Best practices
  'eqeqeq': ['warn', 'always', { null: 'ignore' }],
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-return-await': 'warn',

  // Style (relaxed)
  'semi': ['warn', 'always'],
  'quotes': ['warn', 'single', { avoidEscape: true }],
  'indent': ['warn', 2, { SwitchCase: 1 }],
  'comma-dangle': ['warn', 'never'],
  'no-trailing-spaces': 'warn',
  'eol-last': ['warn', 'always']
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'src/shared/config.js'  // Uses import assertions not supported by ESLint
    ]
  },
  // CommonJS files (main process, modules)
  {
    files: ['**/*.cjs', 'src/main.js', 'src/preload.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...nodeGlobals,
        ...jestGlobals
      }
    },
    rules: commonRules
  },
  // ES Module files (renderer, shared)
  {
    files: ['src/renderer.js', 'src/shared/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...browserGlobals,
        console: 'readonly'
      }
    },
    rules: commonRules
  }
];
