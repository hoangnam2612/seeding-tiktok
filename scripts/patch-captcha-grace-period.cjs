const fs = require('fs');
const path = require('path');

const runnerPath = path.join(__dirname, '..', 'src', 'main', 'automation-runner.ts');
let content = fs.readFileSync(runnerPath, 'utf8');

// 1. In solveTikTokWebCaptchaWithOmo, after successful solve, wait 4.5s for TikTok backend verification token to settle
content = content.replace(
  `    if (!isStillPresent) {
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'success',
        message: \`[Captcha] 🎉 Đã tự động giải và vượt qua thành công CAPTCHA \${taskLabel} cho @\${acc.username}!\`,
      });
      return true;
    }`,
  `    if (!isStillPresent) {
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'success',
        message: \`[Captcha] 🎉 Đã tự động giải và vượt qua thành công CAPTCHA \${taskLabel} cho @\${acc.username}! Đang đợi 4s để TikTok xác nhận phiên...\`,
      });
      await waitForSeedingDelay(4000, win).catch(() => {});
      return true;
    }`
);

// 2. In stabilize loop, ensure we do not close if Captcha is currently visible on screen
content = content.replace(
  `    const stabilizeDeadline = Date.now() + SEEDING_POST_ACTION_STABILIZE_MS;
    while (Date.now() < stabilizeDeadline) {
      throwIfSeedingCancelled(win);
      await checkAndSolveAnyCaptcha(win, acc, onLog);
      await waitForSeedingDelay(1500, win);
    }`,
  `    const stabilizeDeadline = Date.now() + SEEDING_POST_ACTION_STABILIZE_MS;
    while (Date.now() < stabilizeDeadline) {
      throwIfSeedingCancelled(win);
      await checkAndSolveAnyCaptcha(win, acc, onLog);
      await waitForSeedingDelay(1500, win);
    }

    // Final safety check: if Captcha is still on screen, keep window open and solve before closing
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
    }`
);

fs.writeFileSync(runnerPath, content, 'utf8');
console.log('Successfully patched captcha grace period and safety loop!');
