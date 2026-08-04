import type { Config } from 'jest';

// Unit/integration config — specs live next to code (src/**/*.spec.ts).
// E2E suites (test/**/*.e2e-spec.ts) run via jest.e2e.config.ts and need docker services.
const config: Config = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { useESM: true, tsconfig: { verbatimModuleSyntax: false } },
    ],
  },
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/generated/**'],
  coverageDirectory: 'coverage',
};

export default config;
