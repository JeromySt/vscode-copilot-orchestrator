const esbuild = require('esbuild');
const { execSync } = require('child_process');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Capture build-time metadata as compile-time constants
let buildCommit = 'unknown';
try { buildCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf8', timeout: 3000 }).trim(); } catch { /* not in git */ }
const buildTimestamp = new Date().toISOString();
const buildVersion = require('./package.json').version || 'unknown';
const buildDefines = {
  '__BUILD_COMMIT__': JSON.stringify(buildCommit),
  '__BUILD_TIMESTAMP__': JSON.stringify(buildTimestamp),
  '__BUILD_VERSION__': JSON.stringify(buildVersion),
};

async function main() {
  // Main extension bundle
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'warning',
    define: buildDefines,
    plugins: [esbuildProblemMatcherPlugin]
  });

  // MCP stdio server - separate entry point spawned as a child process
  const stdioCtx = await esbuild.context({
    entryPoints: ['src/mcp/stdio/server.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/mcp-stdio-server.js',
    external: ['vscode'],
    logLevel: 'warning',
    define: buildDefines,
    plugins: [esbuildProblemMatcherPlugin]
  });
  if (watch) {
    await Promise.all([ctx.watch(), stdioCtx.watch()]);
  } else {
    await Promise.all([ctx.rebuild(), stdioCtx.rebuild()]);
    await Promise.all([ctx.dispose(), stdioCtx.dispose()]);
  }
}

/** @type {import('esbuild').Plugin} */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd(result => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      });
      console.log('[watch] build finished');
    });
  }
};

main().catch(e => {
  console.error(e);
  process.exit(1);
});
