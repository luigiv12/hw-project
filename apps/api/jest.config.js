/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '\\.(spec|e2e-spec)\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleNameMapper: {
    // Resolve the workspace package to its source so a test run never depends on
    // packages/contracts having been built first.
    '^@emissions/contracts$': '<rootDir>/../../packages/contracts/src/index.ts',

    /**
     * The contracts sources write relative imports with a `.js` extension —
     * correct for the ESM output they compile to, but there are no `.js` files
     * beside the `.ts` sources, so Jest cannot resolve them. Strip the extension
     * and let the resolver find the TypeScript.
     *
     * Must come after the package mapping above; rules are applied in order.
     */
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  setupFiles: ['<rootDir>/test/setup-env.ts'],

  /**
   * Integration tests share one Postgres database and assert on absolute row
   * counts and totals. Running files in parallel would let them interleave, so
   * `pnpm test` passes --runInBand. Concurrency *within* a test is the point and
   * is exercised deliberately with Promise.all.
   */
  maxWorkers: 1,
  testTimeout: 30_000,
};
