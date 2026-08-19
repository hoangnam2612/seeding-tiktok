const fs = require('fs');
const path = require('path');

const runnerPath = path.join(__dirname, '..', 'src', 'main', 'automation-runner.ts');
const lines = fs.readFileSync(runnerPath, 'utf8').split('\n');

let depth = 0;
for (let i = 3153; i < 3805; i++) {
  const line = lines[i];
  const opens = (line.match(/\{/g) || []).length;
  const closes = (line.match(/\}/g) || []).length;
  depth += (opens - closes);
  if (opens !== closes) {
    console.log(`Line ${i + 1} (depth ${depth}): ${line}`);
  }
}
