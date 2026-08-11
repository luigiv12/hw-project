import type { NextConfig } from 'next';
import { join } from 'node:path';

/**
 * `output: 'standalone'` emits a self-contained Node server — the thing the
 * Docker image runs, and the reason that image does not carry the whole
 * node_modules tree. `outputFileTracingRoot` goes with it: tracing has to reach
 * the monorepo root to follow the workspace symlink into packages/contracts.
 *
 * Neither belongs in a build that is not producing that container. A platform
 * building its own serverless output looks for none of it, and the tracing root
 * — being relative to this directory — points outside the project wherever the
 * checkout sits at a different depth.
 *
 * So the container build opts in, and everything else gets Next's default. The
 * flag is set by our own Dockerfile rather than inferred from the host, because
 * the question being answered is "does this build need a standalone server?",
 * not "which vendor am I on?" — a host that happens to be unrecognised should
 * still build correctly.
 */
const standalone = Boolean(process.env.BUILD_STANDALONE);

const nextConfig: NextConfig = {
  ...(standalone
    ? {
        output: 'standalone',
        outputFileTracingRoot: join(__dirname, '..', '..'),
      }
    : {}),

  typedRoutes: true,
};

export default nextConfig;
