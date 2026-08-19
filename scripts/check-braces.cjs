const fs = require('fs');
const path = require('path');

const runnerPath = path.join(__dirname, '..', 'src', 'main', 'automation-runner.ts');
const lines = fs.readFileSync(runnerPath, 'utf8').split('\n');

let depth = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const opens = (line.match(/\{/g) || []).length;
  const closes = (line.match(/\}/g) || []).length;
  depth += (opens - closes);
  if (depth < 0) {
    console.log(`Line ${i + 1} dropped below depth 0:`, line);
    break;
  }
}
console.log('Final depth at EOF:', depth);
