const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve(__dirname, '../tmp/feature-ui');
fs.mkdirSync(output, { recursive: true });
require('esbuild').buildSync({ entryPoints: [path.resolve(__dirname, 'fixtures/feature-workspace.tsx')], bundle: true, outdir: output, entryNames: 'fixture', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'file' } });
fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html lang="vi"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script></html>');
