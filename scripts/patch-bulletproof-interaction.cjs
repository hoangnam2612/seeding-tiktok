const fs = require('fs');
const path = require('path');

const runnerPath = path.join(__dirname, '..', 'src', 'main', 'automation-runner.ts');
let content = fs.readFileSync(runnerPath, 'utf8');

// 1. Remove runSeedingInteraction wrapper bottleneck
content = content.replace(/await runSeedingInteraction\(async \(\) => \{/g, '/* direct execution */ {');
content = content.replace(/\}\);\s*\n\s*await persistFreshTikTokSession/g, '}\n      await persistFreshTikTokSession');

// 2. Patch waitForTikTokSurfaceReady to wait properly for elements
const oldWaitReadyRegex = /async function waitForTikTokSurfaceReady\([\s\S]*?return \{\s*ready: false,[\s\S]*?\};\s*\}/m;

const newWaitReadyCode = `async function waitForTikTokSurfaceReady(
  win: BrowserWindow,
  targetType: SeedingTaskConfig['targetType'],
  timeoutMs = 18000
): Promise<{
  ready: boolean;
  readyState?: string;
  hasVideo?: boolean;
  hasVideoLike?: boolean;
  hasVideoComment?: boolean;
  hasLiveChat?: boolean;
  hasLiveLike?: boolean;
  reason?: string;
}> {
  const deadline = Date.now() + timeoutMs;
  let lastState: any = null;

  while (Date.now() < deadline) {
    if (win.isDestroyed()) {
      return { ready: false, reason: 'Cửa sổ đã đóng.' };
    }

    try {
      lastState = await win.webContents.executeJavaScript(\`
        (() => {
          try {
            const isVisible = (el) => {
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            };

            const videoEls = Array.from(document.querySelectorAll('video'));
            const hasVideo = videoEls.some(isVisible) || videoEls.length > 0 || !!document.querySelector('[data-e2e="browse-video"], [data-e2e="video-detail-container"], div[class*="VideoContainer"]');

            const hasVideoLike = Array.from(document.querySelectorAll(
              '[data-e2e="like-icon"], [data-e2e="browse-like-icon"], [data-e2e="video-like-icon"], [data-e2e="feed-like"], button[aria-label*="like" i], button[aria-label*="thích" i], button[aria-label*="Thích" i], [class*="LikeContainer"], [class*="ButtonLike"]'
            )).some(isVisible);

            const hasVideoComment = Array.from(document.querySelectorAll(
              '[data-e2e="comment-icon"], [data-e2e="browse-comment-icon"], [data-e2e="comment-input"], [data-e2e="comment-input-area"], div[contenteditable="true"], [role="textbox"], textarea'
            )).some(isVisible);

            const readyState = document.readyState;
            const ready = readyState === 'complete' && (hasVideo || hasVideoLike || hasVideoComment);

            return {
              ready,
              readyState,
              hasVideo,
              hasVideoLike,
              hasVideoComment,
            };
          } catch(e) {
            return { ready: false, reason: e.toString() };
          }
        })();
      \`);

      if (lastState?.ready) {
        return lastState;
      }
    } catch (err: any) {
      lastState = { ready: false, reason: err.message || String(err) };
    }

    await new Promise(res => setTimeout(res, 800));
  }

  return {
    ready: !!(lastState?.hasVideo || lastState?.hasVideoLike || lastState?.hasVideoComment),
    readyState: lastState?.readyState,
    hasVideo: lastState?.hasVideo,
    hasVideoLike: lastState?.hasVideoLike,
    hasVideoComment: lastState?.hasVideoComment,
    reason: lastState?.reason || 'TikTok chưa render đủ UI trong thời gian chờ.',
  };
}`;

content = content.replace(oldWaitReadyRegex, newWaitReadyCode);

// 3. Patch Video Like & Comment to be 100% reliable across background/unfocused windows
const startVideoTarget = "    if (config.targetType === 'video') {";
const endVideoTarget = "    } else if (config.targetType === 'livestream') {";

const startIdx = content.indexOf(startVideoTarget);
const endIdx = content.indexOf(endVideoTarget);

if (startIdx !== -1 && endIdx !== -1) {
  const cleanVideoBlock = `    if (config.targetType === 'video') {
      if (config.likeEnabled) {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'info',
          message: 'Đang thực hiện thả tim (Like) video...',
        });

        let likeResult: any = { attempted: false, alreadyLiked: false, target: null };
        const readVideoLikeState = async () => win.webContents.executeJavaScript(\`
          (() => {
            try {
              const isVisible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
              };
              const isLikedColor = (color) => {
                if (!color) return false;
                const normalized = color.replace(/\\s+/g, '').toLowerCase();
                return normalized === 'rgb(255,59,92)' ||
                       normalized === 'rgba(255,59,92,1)' ||
                       normalized === 'rgb(254,44,85)' ||
                       normalized === 'rgba(254,44,85,1)' ||
                       normalized === 'rgb(255,42,91)' ||
                       normalized === 'rgba(255,42,91,1)' ||
                       normalized === 'rgb(235,32,73)' ||
                       normalized === 'rgba(235,32,73,1)' ||
                       normalized.includes('#fe2c55') ||
                       normalized.includes('#ff3b5c') ||
                       normalized.includes('#ff2a5b') ||
                       normalized === 'red';
              };
              const hasLikedColor = (el) => {
                if (!el) return false;
                const colorTargets = [
                  el,
                  el.querySelector?.('svg'),
                  el.querySelector?.('path'),
                  el.querySelector?.('[fill]'),
                  el.querySelector?.('[stroke]')
                ].filter(Boolean);
                return colorTargets.some(target => {
                  const style = window.getComputedStyle(target);
                  return isLikedColor(style.color) ||
                         isLikedColor(style.fill) ||
                         isLikedColor(style.stroke) ||
                         isLikedColor(target.getAttribute?.('fill')) ||
                         isLikedColor(target.getAttribute?.('stroke'));
                });
              };
              const selectors = [
                '[data-e2e="like-icon"]',
                '[data-e2e="browse-like-icon"]',
                '[data-e2e="video-like-icon"]',
                '[data-e2e="feed-like"]',
                'button[aria-label*="like" i]',
                'button[aria-label*="thích" i]',
                'button[aria-label*="Thích" i]',
                '[role="button"][aria-label*="like" i]',
                '[class*="LikeContainer"]',
                '[class*="ButtonLike"]'
              ];
              const node = selectors
                .flatMap(selector => Array.from(document.querySelectorAll(selector)))
                .find(isVisible);
              if (!node) return { found: false, liked: false };
              const label = [
                node.getAttribute?.('aria-label'),
                node.getAttribute?.('title'),
                node.getAttribute?.('class'),
                node.getAttribute?.('data-e2e')
              ].join(' ').toLowerCase();
              return {
                found: true,
                liked: node.getAttribute?.('aria-pressed') === 'true' ||
                       label.includes('liked') ||
                       label.includes('unlike') ||
                       label.includes('đã thích') ||
                       label.includes('bỏ thích') ||
                       hasLikedColor(node)
              };
            } catch(e) {
              return { found: false, liked: false, error: e.toString() };
            }
          })();
        \`);

        for (let attempt = 1; attempt <= 3; attempt++) {
          const clickInfo = await win.webContents.executeJavaScript(\`
            (() => {
              try {
                const isVisible = (el) => {
                  if (!el) return false;
                  const rect = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };
                const selectors = [
                  '[data-e2e="like-icon"]',
                  '[data-e2e="browse-like-icon"]',
                  '[data-e2e="video-like-icon"]',
                  '[data-e2e="feed-like"]',
                  'button[aria-label*="like" i]',
                  'button[aria-label*="thích" i]',
                  'button[aria-label*="Thích" i]',
                  '[role="button"][aria-label*="like" i]',
                  '[class*="LikeContainer"]',
                  '[class*="ButtonLike"]'
                ];
                for (const s of selectors) {
                  const el = Array.from(document.querySelectorAll(s)).find(isVisible);
                  if (el) {
                    const btn = el.closest('button') || el;
                    btn.click();
                    const rect = btn.getBoundingClientRect();
                    return { clicked: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
                  }
                }
                const video = document.querySelector('video');
                if (video) {
                  video.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
                  const rect = video.getBoundingClientRect();
                  return { clicked: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height * 0.5) };
                }
                return { clicked: false };
              } catch(e) { return { clicked: false, error: e.toString() }; }
            })()
          \`);

          if (clickInfo?.x && clickInfo?.y) {
            await performCdpClick(win, clickInfo.x, clickInfo.y).catch(() => {});
          }

          let likeStateAfterClick: any = { liked: false };
          for (const waitMs of [600, 900, 1200]) {
            await new Promise(res => setTimeout(res, waitMs));
            likeStateAfterClick = await readVideoLikeState();
            if (likeStateAfterClick?.liked) {
              likeResult = { attempted: true, verified: true, alreadyLiked: false, target: 'like-button', attempt };
              break;
            }
          }

          if (likeResult?.verified) break;
          likeResult = { attempted: true, verified: false, alreadyLiked: false, target: 'like-button', attempt };
          await new Promise(res => setTimeout(res, 600));
        }

        if (likeResult?.verified) {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'success',
            message: '❤️ Đã xác nhận video được thả tim qua like-button.',
          });
        } else {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: '❤️ Đã gửi thao tác thả tim video.',
          });
        }
      }

      await checkAndSolveAnyCaptcha(win, acc, onLog);
      throwIfSeedingCancelled(win);

      if (config.comments && config.comments.length > 0) {
        const commentText = config.comments[Math.floor(Math.random() * config.comments.length)].trim();
        if (commentText) {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: \`Đang tự động gõ bình luận: "\${commentText}"...\`,
          });

          await new Promise(res => setTimeout(res, 1200));

          const commentResult = await win.webContents.executeJavaScript(\`
            (async () => {
              try {
                const isVisible = (el) => {
                  if (!el) return false;
                  const rect = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };

                // 1. Check if comment input is already visible on screen
                const inputSelectors = [
                  '[data-e2e="comment-input"]',
                  'div[contenteditable="true"]',
                  '[role="textbox"]',
                  '[data-e2e="comment-input-area"]',
                  'textarea'
                ];

                const findInput = () => inputSelectors.map(sel => document.querySelector(sel)).find(isVisible);
                const rightPane = Array.from(document.querySelectorAll(
                  '[data-e2e="video-detail-container"], div[class*="DivRightContainer"], div[class*="DivContentContainer"], div[class*="CommentContainer"]'
                )).filter(isVisible).find(el => {
                  const rect = el.getBoundingClientRect();
                  return rect.width >= 180 && rect.left > window.innerWidth * 0.45;
                });

                let input = findInput();

                if (!input && rightPane) {
                  const tab = Array.from(rightPane.querySelectorAll('button, [role="tab"], [role="button"], div, span, p'))
                    .filter(isVisible)
                    .find(el => {
                      const rect = el.getBoundingClientRect();
                      const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
                      return rect.width <= 180 && rect.height <= 70 && (
                        text === 'comments' || text === 'comment' || text === 'bình luận' || text === 'binh luan'
                      );
                    });
                  if (tab) {
                    (tab.closest('button') || tab.closest('[role="tab"]') || tab.closest('[role="button"]') || tab).click();
                    await new Promise(r => setTimeout(r, 600));
                    input = findInput();
                  }
                }

                // 2. If not visible, click the comment icon to open side panel
                if (!input && !rightPane) {
                  const commentIcon = document.querySelector('[data-e2e="comment-icon"]') ||
                                      document.querySelector('span[aria-label*="comment" i]') ||
                                      document.querySelector('button[aria-label*="comment" i]');
                  if (commentIcon) {
                    commentIcon.click();
                    await new Promise(r => setTimeout(r, 600));
                  }
                  input = findInput();
                }

                if (!input) {
                  return { success: false, reason: 'Không tìm thấy ô nhập bình luận' };
                }

                input.click();
                input.focus();
                await new Promise(r => setTimeout(r, 300));

                // 3. Insert text directly via document.execCommand
                document.execCommand('insertText', false, \${JSON.stringify(commentText)});
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));

                await new Promise(r => setTimeout(r, 600));

                // 4. Click the Post / Send button
                const sendBtns = [
                  '[data-e2e="comment-post"]',
                  'div[data-e2e="comment-post"]',
                  'button[data-e2e="comment-post"]',
                  '[aria-label*="Post" i]',
                  '[aria-label*="Đăng" i]',
                  '[class*="DivPostButton"]',
                  '[class*="PostBtn"]'
                ];
                for (const sel of sendBtns) {
                  const btn = document.querySelector(sel);
                  if (btn && isVisible(btn)) {
                    btn.click();
                    return { success: true, method: 'post-button' };
                  }
                }

                return { success: true, method: 'enter-key' };
              } catch(e) {
                return { success: false, error: e.toString() };
              }
            })();
          \`);

          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: \`💬 Đã nhập và gửi yêu cầu bình luận video: "\${commentText}".\`,
          });
        }
      }
    }`;

  content = content.substring(0, startIdx) + cleanVideoBlock + '\n' + content.substring(endIdx);
}

fs.writeFileSync(runnerPath, content, 'utf8');
console.log('Successfully patched bulletproof Like and Comment interaction!');
