import * as fs from 'fs';
import * as path from 'path';
import { ensurePersistentDataDir } from '../data-dir';

const PROFILES_DIR_NAME = 'profiles';

/**
 * Returns the base root folder where all account profiles are stored
 */
export function getProfilesRootDir(): string {
  const dataDir = ensurePersistentDataDir();
  const profilesDir = path.join(dataDir, PROFILES_DIR_NAME);
  if (!fs.existsSync(profilesDir)) {
    fs.mkdirSync(profilesDir, { recursive: true });
  }
  return profilesDir;
}

/**
 * Clean any stale lock files left by previous crashed Chrome instances.
 * Chrome on Windows creates 'SingletonLock', 'SingletonCookie', 'SingletonSocket' which can prevent reuse.
 */
export function cleanStaleProfileLocks(profilePath: string) {
  if (!fs.existsSync(profilePath)) return;

  const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'parent.lock'];
  for (const lockFile of lockFiles) {
    const fullPath = path.join(profilePath, lockFile);
    try {
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    } catch {
      // Ignored if file is actively locked by a running process
    }
  }
}

/**
 * Returns the dedicated directory path for a specific account's Chrome profile.
 */
export function getAccountProfileDir(accountId: string): string {
  const safeId = (accountId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  const baseProfilesDir = getProfilesRootDir();
  const profileDir = path.join(baseProfilesDir, safeId);

  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  cleanStaleProfileLocks(profileDir);
  return profileDir;
}
