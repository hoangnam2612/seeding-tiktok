const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const headFile = execSync('git show HEAD:src/main/automation-runner.ts', { maxBuffer: 10 * 1024 * 1024 }).toString('utf8');
const currentFile = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'automation-runner.ts'), 'utf8');

// 1. Extract our perfected Captcha solving functions from current file
const captchaStartMarker = 'function getOmoCaptchaApiKey(): string {';
const captchaEndMarker = 'async function checkAndSolveAnyCaptcha(';

const currentCaptchaStartIndex = currentFile.indexOf(captchaStartMarker);
const currentCaptchaEndIndex = currentFile.indexOf('async function executeTaskForAccount(');

if (currentCaptchaStartIndex === -1 || currentCaptchaEndIndex === -1) {
  console.error('Could not find captcha section in current file!');
  process.exit(1);
}

const perfectedCaptchaCode = currentFile.substring(currentCaptchaStartIndex, currentCaptchaEndIndex);

// 2. Locate captcha section in HEAD file
const headCaptchaStartIndex = headFile.indexOf(captchaStartMarker);
const headCaptchaEndIndex = headFile.indexOf('async function executeTaskForAccount(');

if (headCaptchaStartIndex === -1 || headCaptchaEndIndex === -1) {
  console.error('Could not find captcha section in HEAD file!');
  process.exit(1);
}

// 3. Assemble reverted file with perfected captcha code
let newFile = headFile.substring(0, headCaptchaStartIndex) + perfectedCaptchaCode + headFile.substring(headCaptchaEndIndex);

// 4. Also keep the safety check before window close if present
const headCloseMarker = `    await persistTikTokSessionCookies(
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
              return rect.width > 20 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
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

if (newFile.includes(headCloseMarker)) {
  newFile = newFile.replace(headCloseMarker, currentSafetyCheck);
}

fs.writeFileSync(path.join(__dirname, '..', 'src', 'main', 'automation-runner.ts'), newFile, 'utf8');
console.log('Successfully reverted all non-captcha code to HEAD commit while keeping captcha solver!');
