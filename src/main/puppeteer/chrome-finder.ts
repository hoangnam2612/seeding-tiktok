import * as fs from 'fs';
import * as path from 'path';

/**
 * Common standard install locations for Google Chrome & Chromium-based browsers on Windows / macOS / Linux
 */
function getCandidateChromePaths(): string[] {
  const isWindows = process.platform === 'win32';
  const isMac = process.platform === 'darwin';

  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const userProfile = process.env.USERPROFILE || '';

    return [
      // Official Google Chrome 64-bit & 32-bit
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(userProfile, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',

      // Google Chrome Beta / Dev / Canary
      path.join(localAppData, 'Google', 'Chrome SxS', 'Application', 'chrome.exe'),
      path.join(programFiles, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'),

      // Brave Browser (Chromium-based alternative)
      path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),

      // Microsoft Edge (Chromium-based fallback)
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
  }

  if (isMac) {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }

  // Linux
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
}

/**
 * Locate the available Chrome or Chromium executable on the system.
 * Throws a clear error if no supported browser is installed.
 */
export function findChromeExecutable(customPath?: string): string {
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }

  const candidates = getCandidateChromePaths();
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    'Không tìm thấy trình duyệt Google Chrome trên máy tính của bạn. Vui lòng cài đặt Google Chrome để sử dụng chức năng này.'
  );
}
