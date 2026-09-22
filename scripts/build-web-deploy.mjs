#!/usr/bin/env node
// Packages apps/web as a self-contained directory for `npx @insforge/cli deployments deploy`.
//
// The InsForge → Vercel deploy uploads one directory and builds it as a standalone project,
// so the pnpm workspace dependency on @bmb/shared cannot be resolved there. This script:
//   1. copies apps/web (minus node_modules, .next, env files, tests) to out/web-deploy
//   2. vendors packages/shared's built output under vendor/shared/lib  (not "dist": the
//      uploader strips dist/ and build/ folders)
//   3. rewrites the dependency to `file:./vendor/shared` and the build script to `next build`
// Run:  pnpm --filter @bmb/shared build && node scripts/build-web-deploy.mjs
// Then: cd control && npx @insforge/cli deployments deploy <printed path> --json   (or pass --out <dir>)
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const src = path.join(root, 'apps/web');
// Default to a temp dir: the repo may live under a syncing folder (OneDrive) that locks files.
const outArg = process.argv.indexOf('--out');
const out = outArg >= 0 && process.argv[outArg + 1] ? path.resolve(process.argv[outArg + 1]) : path.join(tmpdir(), 'bmb-web-deploy');
const sharedDist = path.join(root, 'packages/shared/dist');
if (!existsSync(sharedDist)) throw new Error('build @bmb/shared first');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const skip = new Set(['node_modules', '.next', 'tests', 'next-env.d.ts']);
cpSync(src, out, {
  recursive: true,
  filter: (p) => {
    const rel = path.relative(src, p);
    if (!rel) return true;
    const top = rel.split(path.sep)[0];
    if (skip.has(top)) return false;
    return !path.basename(p).startsWith('.env');
  },
});

const vendor = path.join(out, 'vendor/shared');
mkdirSync(vendor, { recursive: true });
cpSync(sharedDist, path.join(vendor, 'lib'), { recursive: true });
const sharedPkg = JSON.parse(readFileSync(path.join(root, 'packages/shared/package.json'), 'utf8'));
writeFileSync(
  path.join(vendor, 'package.json'),
  JSON.stringify(
    {
      name: sharedPkg.name,
      version: sharedPkg.version,
      private: true,
      type: 'module',
      main: './lib/index.js',
      types: './lib/index.d.ts',
      exports: { '.': { types: './lib/index.d.ts', import: './lib/index.js' } },
      dependencies: sharedPkg.dependencies,
    },
    null,
    2,
  ),
);

const pkgPath = path.join(out, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.dependencies['@bmb/shared'] = 'file:./vendor/shared';
pkg.scripts = { build: 'next build', start: 'next start' };
delete pkg.devDependencies.vitest;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

// tsconfig: drop the workspace-only includes and the vitest types.
const tsPath = path.join(out, 'tsconfig.json');
const ts = JSON.parse(readFileSync(tsPath, 'utf8'));
ts.extends = undefined;
ts.compilerOptions = {
  target: 'ES2022',
  lib: ['DOM', 'DOM.Iterable', 'ES2023'],
  module: 'ESNext',
  moduleResolution: 'Bundler',
  jsx: 'preserve',
  strict: true,
  noEmit: true,
  allowJs: true,
  incremental: true,
  esModuleInterop: true,
  skipLibCheck: true,
  isolatedModules: true,
  resolveJsonModule: true,
  plugins: [{ name: 'next' }],
  paths: { '@/*': ['./*'] },
};
ts.include = ['**/*.ts', '**/*.tsx', '.next/types/**/*.ts'];
ts.exclude = ['node_modules', '.next', 'vendor'];
writeFileSync(tsPath, JSON.stringify(ts, null, 2));

// Tell Vercel which framework this is; the InsForge deploy flow does not set a preset.
writeFileSync(path.join(out, 'vercel.json'), JSON.stringify({ framework: 'nextjs' }, null, 2));

console.log(`wrote ${out}`);
