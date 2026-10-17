/**
 * Jest configuration for VibeMon
 */

module.exports = {
  testEnvironment: 'node',
  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/out/'],
  testMatch: [
    '**/tests/**/*.test.js',
    '**/__tests__/**/*.js'
  ],
  collectCoverageFrom: [
    'src/application/**/*.cjs',
    'src/modules/**/*.{js,cjs}',
    'src/monitoring/**/*.cjs',
    'src/workspace/**/*.cjs',
    'src/widgets/**/*.cjs',
    'src/shared/**/*.{js,cjs}',
    '!**/node_modules/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 60,
      lines: 60,
      statements: 60
    }
  },
  moduleFileExtensions: ['js', 'cjs', 'mjs', 'json'],
  // Main-process modules require shared ES modules; Jest loads CommonJS only.
  transform: {
    '\\.[jt]sx?$': 'babel-jest',
    '\\.mjs$': '<rootDir>/tests/helpers/esm-transform.cjs'
  },
  verbose: true
};
