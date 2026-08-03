/**
 * Build the two SDK bundles with esbuild:
 *   - loader: the host-page SDK, emitted as IIFE (global `ProctorLink`), ESM and CJS
 *   - enclave: the iframe app, emitted as a self-contained IIFE + its HTML shell
 *
 * Run: npm run build   (types: npm run types)
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const out = resolve(root, 'dist');

rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, 'enclave'), { recursive: true });

const common = { bundle: true, minify: true, sourcemap: true, target: ['es2020'], logLevel: 'info' };

// Loader — three module formats so it drops into Angular (import), plain <script> (iife) or CJS.
await build({
  ...common,
  entryPoints: [resolve(root, 'src/loader/index.ts')],
  outfile: resolve(out, 'proctorlink.js'),
  format: 'iife',
  globalName: 'ProctorLink',
  footer: { js: 'window.ProctorLink = ProctorLink.ProctorLink || ProctorLink.default || ProctorLink;' },
});
await build({ ...common, entryPoints: [resolve(root, 'src/loader/index.ts')], outfile: resolve(out, 'proctorlink.esm.js'), format: 'esm' });
await build({ ...common, entryPoints: [resolve(root, 'src/loader/index.ts')], outfile: resolve(out, 'proctorlink.cjs'), format: 'cjs' });

// Enclave — bundled IIFE loaded by enclave.html.
await build({
  ...common,
  entryPoints: [resolve(root, 'src/enclave/enclave.ts')],
  outfile: resolve(out, 'enclave/enclave.js'),
  format: 'iife',
});
cpSync(resolve(root, 'src/enclave/enclave.html'), resolve(out, 'enclave/enclave.html'));

console.log('\n✓ build complete -> dist/');
