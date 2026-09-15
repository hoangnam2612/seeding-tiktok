const { spawnSync } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..');
const result = spawnSync('dotnet', ['publish', path.join(root, 'native-engine/TikTokEngine.csproj'), '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', path.join(root, 'native-engine/publish'), '-v', 'minimal'], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) console.error('Cần .NET SDK để build C# engine:', result.error.message);
process.exit(result.status ?? 1);
