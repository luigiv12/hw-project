import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * Emits a self-contained server bundle with only the files it actually needs,
   * so the production image does not carry the whole node_modules tree.
   */
  output: 'standalone',

  /**
   * The monorepo root, so tracing for the standalone build follows the pnpm
   * workspace symlink into packages/contracts instead of stopping at apps/web.
   */
  outputFileTracingRoot: __dirname + '/../..',

  typedRoutes: true,
};

export default nextConfig;
