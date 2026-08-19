const fs = require('fs');
const path = require('path');

const runnerPath = path.join(__dirname, '..', 'src', 'main', 'automation-runner.ts');
let content = fs.readFileSync(runnerPath, 'utf8');

// Find the start of targetType check
const startIdx = content.indexOf("    if (config.targetType === 'video') {");
// Find the start of stabilizeDeadline
const endIdx = content.indexOf("    const stabilizeDeadline = Date.now() + SEEDING_POST_ACTION_STABILIZE_MS;");

if (startIdx === -1 || endIdx === -1) {
  console.error('Could not find start/end markers!');
  process.exit(1);
}

const cleanTargetTypeBlock = `    if (config.targetType === 'video') {
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
                '[data-e2e="search-like-icon"]',
                '[data-e2e*="like"]',
                'button[data-e2e*="like" i]',
                'button[aria-label*="like" i]',
                'button[aria-label*="thích" i]',
                'button[aria-label*="Thích" i]',
                '[role="button"][aria-label*="like" i]',
                'span[aria-label*="like" i]',
                'div[class*="LikeContainer"]',
                'button[class*="ButtonLike"]'
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
          const likeTarget = await win.webContents.executeJavaScript(\`
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
                    const rect = el.getBoundingClientRect();
                    return {
                      found: true,
                      x: Math.round(rect.left + rect.width / 2),
                      y: Math.round(rect.top + rect.height / 2),
                      target: 'like-button'
                    };
                  }
                }
                const video = document.querySelector('video');
                if (video) {
                  const rect = video.getBoundingClientRect();
                  return {
                    found: true,
                    x: Math.round(rect.left + rect.width / 2),
                    y: Math.round(rect.top + rect.height * 0.5),
                    target: 'video-dblclick'
                  };
                }
                return { found: false };
              } catch(e) { return { found: false, error: e.toString() }; }
            })()
          \`);

          // Direct click via DOM + CDP click
          await win.webContents.executeJavaScript(\`
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
                    return true;
                  }
                }
                const video = document.querySelector('video');
                if (video) {
                  video.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
                }
              } catch (e) {}
            })()
          \`).catch(() => {});

          if (likeTarget?.found && typeof likeTarget.x === 'number') {
            await performCdpClick(win, likeTarget.x, likeTarget.y).catch(() => {});
          }

          let likeStateAfterClick: any = { liked: false };
          for (const waitMs of [500, 800, 1000]) {
            await new Promise(res => setTimeout(res, waitMs));
            likeStateAfterClick = await readVideoLikeState();
            if (likeStateAfterClick?.liked) {
              likeResult = { attempted: true, verified: true, alreadyLiked: false, target: likeTarget?.target || 'like-button', attempt };
              break;
            }
          }

          if (likeResult?.verified) break;
          likeResult = { attempted: true, verified: false, alreadyLiked: false, target: likeTarget?.target || 'like-button', attempt };
          await new Promise(res => setTimeout(res, 500));
        }

        if (likeResult?.verified) {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'success',
            message: \`❤️ Đã xác nhận video được thả tim qua \${likeResult.target}.\`,
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

          await new Promise(res => setTimeout(res, 1500));

          const focusResult = await win.webContents.executeJavaScript(\`
            (async () => {
              try {
                const commentIcon = document.querySelector('[data-e2e="comment-icon"]') ||
                                    document.querySelector('span[aria-label*="comment" i]') ||
                                    document.querySelector('button[aria-label*="comment" i]');
                if (commentIcon) {
                  commentIcon.click();
                  await new Promise(r => setTimeout(r, 400));
                }

                const selectors = [
                  '[data-e2e="comment-input"]',
                  'div[contenteditable="true"]',
                  '[role="textbox"]',
                  '[data-e2e="comment-input-area"]',
                  'textarea'
                ];

                let input = null;
                for (const sel of selectors) {
                  const el = document.querySelector(sel);
                  if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
                    input = el;
                    break;
                  }
                }

                if (input) {
                  input.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  await new Promise(r => setTimeout(r, 300));
                  input.click();
                  input.focus();
                  return { success: true };
                }

                return { success: false };
              } catch(e) {
                return { success: false, error: e.toString() };
              }
            })();
          \`);

          if (focusResult && focusResult.success) {
            await waitForSeedingDelay(300, win);

            await win.webContents.executeJavaScript(\`
              (() => {
                try {
                  const input = document.querySelector('[data-e2e="comment-input"], div[contenteditable="true"], [role="textbox"], textarea');
                  if (input) {
                    input.focus();
                    document.execCommand('insertText', false, \${JSON.stringify(commentText)});
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                } catch(e) {}
              })()
            \`);

            await waitForSeedingDelay(500, win);

            await win.webContents.executeJavaScript(\`
              (() => {
                try {
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
                    if (btn && btn.offsetWidth > 0) {
                      btn.click();
                      return true;
                    }
                  }
                } catch(e) {}
              })()
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
      }
    } else if (config.targetType === 'livestream') {
      const liveDurationSeconds = Math.max(10, config.liveDurationSeconds || 60);

      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'info',
        message: \`Đang giữ livestream \${liveDurationSeconds}s cho @\${acc.username}\${config.likeEnabled ? ' và tap live liên tục...' : '...'}\`,
      });

      const liveLikeWarmupPromise = config.likeEnabled && config.comments && config.comments.length > 0
        ? tapLiveContinuously(win, acc, Math.min(8, liveDurationSeconds), onLog, 'warmup')
        : Promise.resolve(0);

      await checkAndSolveAnyCaptcha(win, acc, onLog);
      throwIfSeedingCancelled(win);
      if (config.comments && config.comments.length > 0) {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'info',
          message: \`⏳ Vừa vào Livestream, đang chờ \${Math.round(LIVESTREAM_INITIAL_COMMENT_DELAY_MS / 1000)}s trước khi bắt đầu bình luận cho @\${acc.username}...\`,
        });
        await waitForSeedingDelay(LIVESTREAM_INITIAL_COMMENT_DELAY_MS, win);
        await liveLikeWarmupPromise.catch(() => 0);
        throwIfSeedingCancelled(win);

        const liveCommentText = config.comments[Math.floor(Math.random() * config.comments.length)].trim();
        if (liveCommentText) {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: \`Đang tìm ô bình luận Live để gửi: "\${liveCommentText}"...\`,
          });

          await win.webContents.executeJavaScript(\`
            (() => {
              try {
                const input = document.querySelector('[data-e2e="room-chat-input-field"], div[contenteditable="true"], [role="textbox"], textarea');
                if (input) {
                  input.focus();
                  document.execCommand('insertText', false, \${JSON.stringify(liveCommentText)});
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                }
                const sendBtn = document.querySelector('[data-e2e="room-chat-send-btn"]');
                if (sendBtn) sendBtn.click();
              } catch(e) {}
            })()
          \`);

          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: \`💬 Đã click nút gửi bình luận Live: "\${liveCommentText}".\`,
          });
        }
      }

      if (config.likeEnabled) {
        await tapLiveContinuously(win, acc, liveDurationSeconds, onLog, 'main');
      } else {
        await waitForSeedingDelay(liveDurationSeconds * 1000, win);
      }
    }

`;

content = content.substring(0, startIdx) + cleanTargetTypeBlock + content.substring(endIdx);
fs.writeFileSync(runnerPath, content, 'utf8');
console.log('Successfully applied clean seeding flow!');
