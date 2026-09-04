const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const ignored = new Set(['node_modules', 'coverage', 'dist']);

function collectJavaScript(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) collectJavaScript(absolute, files);
    else if (/\.(?:js|cjs)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

const files = collectJavaScript(root);
let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || `Syntax check failed: ${file}\n`);
  }
}

if (failed) process.exit(1);
console.log(`Syntax check passed for ${files.length} JavaScript files.`);
