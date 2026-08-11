import type { NextConfig } from 'next';
import { join } from 'node:path';

/**
 * `standalone` output emits a self-contained Node server, which is what the
 * Docker image runs — it keeps the image from carrying the whole node_modules
 * tree. Vercel does not run a Node server; it builds its own serverless output,
 * and asking for standalone alongside it produces a file-tracing manifest Vercel
 * never looks for.
 *
 * `outputFileTracingRoot` is part of the same story: tracing has to reach the
 * monorepo root to follow the workspace symlink into packages/contracts. On
 * Vercel the project is checked out at a different depth, so the same relative
 * path points outside the build.
 *
 * Both settings therefore apply only when this is *not* a Vercel build. Vercel
 * sets VERCEL=1 in every build environment.
 */
const isVercelBuild = Boolean(process.env.VERCEL);

const nextConfig: NextConfig = {
  ...(isVercelBuild
    ? {}
    : {
        output: 'standalone',
        outputFileTracingRoot: join(__dirname, '..', '..'),
      }),

  typedRoutes: true,
};

export default nextConfig;
