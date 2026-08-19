const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PREV_COMMIT = '225d43e';

// 1. Read files from previous commit
const prevRunnerCode = execSync(`git show ${PREV_COMMIT}:src/main/automation-runner.ts`, { maxBuffer: 10 * 1024 * 1024 }).toString('utf8');
const prevAppCode = execSync(`git show ${PREV_COMMIT}:src/renderer/src/App.tsx`, { maxBuffer: 10 * 1024 * 1024 }).toString('utf8');

// 2. Read our current runner code with the perfected captcha solver
const currentRunnerCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'automation-runner.ts'), 'utf8');

// 3. Extract the perfected captcha solver from currentRunnerCode
const captchaStartMarker = 'function getOmoCaptchaApiKey(): string {';
const captchaEndMarker = 'async function executeTaskForAccount(';

const currentStart = currentRunnerCode.indexOf(captchaStartMarker);
const currentEnd = currentRunnerCode.indexOf(captchaEndMarker);

if (currentStart === -1 || currentEnd === -1) {
  console.error('Could not find captcha section in current runner code!');
  process.exit(1);
}

const perfectedCaptchaSection = currentRunnerCode.substring(currentStart, currentEnd);

// 4. Locate where captcha section should go in the previous commit's runner code
const prevStart = prevRunnerCode.indexOf(captchaStartMarker);
const prevEnd = prevRunnerCode.indexOf(captchaEndMarker);

if (prevStart === -1 || prevEnd === -1) {
  console.error('Could not find captcha section in previous commit code!');
  process.exit(1);
}

let mergedRunnerCode = prevRunnerCode.substring(0, prevStart) + perfectedCaptchaSection + prevRunnerCode.substring(prevEnd);

// 5. Also keep the safety check before window close
const prevCloseMarker = `    await persistTikTokSessionCookies(
      acc.id,
      acc.username,
      customSession,
      onLog,
      onAccountSessionUpdate,
      '[Seeding] '
    );`;

const currentSafetyCheck = `    // Final safety check: if Captcha is still on screen, keep window open and solve before closing
    let safetyRetries = 0;
    while (safetyRetries < 3) {
      if (win.isDestroyed() || isSeedingCancelRequested()) break;
      const hasActiveCaptcha = await win.webContents.executeJavaScript(\`
        (() => {
          try {
            const isVisible = (el) => {
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 20 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none';
            };
            const selectors = [
              '#captcha-verify-container', '.captcha-verify-container',
              '#captcha_verify_container', '.captcha_verify_container',
              '.sec-captcha-container', '.captcha-container', '.verify-wrap',
              '[class*="captcha-card" i]', '[class*="captcha-modal" i]',
              '[class*="captcha_card" i]', '[class*="captcha_modal" i]',
              'iframe[src*="captcha"]', 'iframe[src*="sec"]', 'iframe[src*="verify"]'
            ];
            return selectors.some(s => Array.from(document.querySelectorAll(s)).some(isVisible));
          } catch(e) { return false; }
        })();
      \`).catch(() => false);

      if (!hasActiveCaptcha) break;

      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'warning',
        message: \`[Captcha] ⏳ Phát hiện CAPTCHA vẫn đang hiển thị, giữ cửa sổ để tiếp tục giải cho @\${acc.username}...\`,
      });
      await solveTikTokWebCaptchaWithOmo(win, acc, onLog);
      safetyRetries++;
      await waitForSeedingDelay(3000, win).catch(() => {});
    }
    throwIfSeedingCancelled(win);
    await persistTikTokSessionCookies(
      acc.id,
      acc.username,
      customSession,
      onLog,
      onAccountSessionUpdate,
      '[Seeding] '
    );`;

if (mergedRunnerCode.includes(prevCloseMarker)) {
  mergedRunnerCode = mergedRunnerCode.replace(prevCloseMarker, currentSafetyCheck);
}

// 6. Write the merged runner and restored App.tsx
fs.writeFileSync(path.join(__dirname, '..', 'src', 'main', 'automation-runner.ts'), mergedRunnerCode, 'utf8');
fs.writeFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'App.tsx'), prevAppCode, 'utf8');

console.log('Successfully reverted codebase to previous commit 225d43e while keeping perfected Captcha solver intact!');
