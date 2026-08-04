import type { Config } from 'jest';

// E2E: real Postgres + Redis from docker-compose required.
// Self-contained (jest cannot import the base .ts config across ESM boundaries).
const config: Config = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.e2e-spec.ts'],
  testTimeout: 30_000,
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: { verbatimModuleSyntax: false } }],
  },
  setupFiles: ['<rootDir>/test/setup-env.ts'],
};

export default config;
