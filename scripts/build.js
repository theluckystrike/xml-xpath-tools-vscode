'use strict';
// Bundles the extension host and the worker with esbuild.
const esbuild = require('esbuild');
const path = require('path');
const root = path.join(__dirname, '..');
const prod = process.argv.includes('--production');
const common = { bundle: true, minify: prod, sourcemap: !prod, legalComments: 'none', logLevel: 'warning', absWorkingDir: root, platform: 'node', format: 'cjs', target: 'node18' };
Promise.all([
  esbuild.build({ ...common, entryPoints: ['src/extension.js'], outfile: 'dist/extension.js', external: ['vscode'] }),
  esbuild.build({ ...common, entryPoints: ['src/worker.js'], outfile: 'dist/worker.js' }),
]).catch(() => process.exit(1));
