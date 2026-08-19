import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR_NAME = 'data';

export function getPersistentDataDir(): string {
  const baseDir = app.isReady()
    ? app.getPath('userData')
    : path.join(process.env.APPDATA || process.cwd(), 'Seeding TikTok');
  return path.join(baseDir, DATA_DIR_NAME);
}

export function ensurePersistentDataDir(): string {
  const dataDir = getPersistentDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  migrateLegacyDataFiles(dataDir);
  return dataDir;
}

function migrateLegacyDataFiles(targetDataDir: string) {
  const legacyDataDir = path.join(process.cwd(), DATA_DIR_NAME);
  if (path.resolve(legacyDataDir) === path.resolve(targetDataDir)) return;
  if (!fs.existsSync(legacyDataDir)) return;

  for (const fileName of ['accounts.json', 'categories.json', 'proxies.json', 'settings.json']) {
    const sourcePath = path.join(legacyDataDir, fileName);
    const targetPath = path.join(targetDataDir, fileName);
    if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) continue;

    try {
      fs.copyFileSync(sourcePath, targetPath);
      console.log(`[Data] Migrated ${fileName} to ${targetDataDir}`);
    } catch (err) {
      console.error(`[Data] Failed to migrate ${fileName}:`, err);
    }
  }
}
