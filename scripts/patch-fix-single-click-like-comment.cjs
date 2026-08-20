const fs = require('fs');
const path = require('path');

const runnerPath = path.join(__dirname, '..', 'src', 'main', 'automation-runner.ts');
let content = fs.readFileSync(runnerPath, 'utf8');

// 1. Patch Like execution in video mode
const oldVideoLikeRegex = /if \(config\.likeEnabled\) \{\s*onLog\(\{\s*accountId: acc\.id,\s*accountUsername: acc\.username,\s*level: 'info',\s*message: 'Đang thực hiện thả tim \(Like\) video\.\.\.',\s*\}\);[\s\S]*?if \(likeResult\?\.verified\) \{\s*onLog\(\{[\s\S]*?\}\);\s*\}\s*\}/m;

const newVideoLikeBlock = `if (config.likeEnabled) {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'info',
          message: 'Đang thực hiện thả tim (Like) video...',
        });

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

        // Check if already liked first
        const initialState = await readVideoLikeState();
        if (initialState?.liked) {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: '❤️ Video đã được thả tim sẵn, bỏ qua bấm lại.',
          });
        } else {
          let likedSuccess = false;
          for (let attempt = 1; attempt <= 2; attempt++) {
            const singleClickResult = await win.webContents.executeJavaScript(\`
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
                      return { clicked: true, target: 'like-button' };
                    }
                  }
                  const video = document.querySelector('video');
                  if (video) {
                    video.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
                    return { clicked: true, target: 'video-dblclick' };
                  }
                  return { clicked: false };
                } catch(e) { return { clicked: false, error: e.toString() }; }
              })()
            \`);

            await waitForSeedingDelay(1000, win);
            const stateAfter = await readVideoLikeState();
            if (stateAfter?.liked) {
              likedSuccess = true;
              break;
            }
          }

          if (likedSuccess) {
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'success',
              message: '❤️ Đã xác nhận video được thả tim thành công.',
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
      }`;

content = content.replace(oldVideoLikeRegex, newVideoLikeBlock);

// 2. Patch Comment execution in video mode
const oldVideoCommentRegex = /if \(config\.comments && config\.comments\.length > 0\) \{\s*const commentText = config\.comments\[Math\.floor\(Math\.random\(\) \* config\.comments\.length\)\]\.trim\(\);[\s\S]*?\}\s*\}\s*\} else if \(config\.targetType === 'livestream'\) \{/m;

const newVideoCommentBlock = `if (config.comments && config.comments.length > 0) {
        const commentText = config.comments[Math.floor(Math.random() * config.comments.length)].trim();
        if (commentText) {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: \`Đang tự động gõ bình luận: "\${commentText}"...\`,
          });

          await waitForSeedingDelay(1200, win);

          const commentResult = await win.webContents.executeJavaScript(\`
            (async () => {
              try {
                const isVisible = (el) => {
                  if (!el) return false;
                  const rect = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };

                const inputSelectors = [
                  '[data-e2e="comment-input"]',
                  'div[contenteditable="true"]',
                  'div[contenteditable="plaintext-only"]',
                  'div[contenteditable]',
                  '[role="textbox"]',
                  '[data-e2e="comment-input-area"]',
                  'div[class*="BottomCommentContainer"]',
                  'div[class*="DivCommentInput"]',
                  'div[class*="InputArea"]',
                  'textarea'
                ];

                // Scroll right sidebar to reveal comment box
                const commentContainers = document.querySelectorAll(
                  '[data-e2e="video-detail-container"], div[class*="CommentContainer"], div[class*="DivCommentListContainer"], div[class*="DivRightContainer"], div[class*="DivContentContainer"]'
                );
                commentContainers.forEach(c => {
                  try { c.scrollTop = c.scrollHeight; } catch(e) {}
                });

                let input = inputSelectors.map(sel => document.querySelector(sel)).find(isVisible);
                if (!input) {
                  const allTextBoxes = Array.from(document.querySelectorAll('div, p, span, textarea, input')).filter(el => {
                    if (!isVisible(el)) return false;
                    const placeholder = (el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('aria-label') || '').toLowerCase();
                    return placeholder.includes('comment') || placeholder.includes('bình luận') || placeholder.includes('add comment') || placeholder.includes('thêm bình luận');
                  });
                  input = allTextBoxes[0];
                }

                if (!input) {
                  return { success: false, reason: 'Không tìm thấy ô nhập bình luận' };
                }

                input.scrollIntoView({ behavior: 'instant', block: 'center' });
                await new Promise(r => setTimeout(r, 200));

                input.click();
                input.focus();
                await new Promise(r => setTimeout(r, 200));

                const editable = input.getAttribute('contenteditable') ? input :
                  (input.querySelector('[contenteditable], [role="textbox"], textarea, input') || input);

                editable.focus();

                // Select existing text if any and insert new comment
                try {
                  const selection = window.getSelection();
                  const range = document.createRange();
                  range.selectNodeContents(editable);
                  selection.removeAllRanges();
                  selection.addRange(range);
                } catch(e) {}

                document.execCommand('insertText', false, \${JSON.stringify(commentText)});
                editable.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                editable.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

                // Synthetic InputEvent for React/DraftJS
                try {
                  editable.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    cancelable: true,
                    inputType: 'insertText',
                    data: \${JSON.stringify(commentText)}
                  }));
                } catch(e) {}

                await new Promise(r => setTimeout(r, 600));

                // Find Post button
                const sendBtns = [
                  '[data-e2e="comment-post"]',
                  'div[data-e2e="comment-post"]',
                  'button[data-e2e="comment-post"]',
                  '[aria-label*="Post" i]',
                  '[aria-label*="Đăng" i]',
                  '[class*="DivPostButton"]',
                  '[class*="PostBtn"]',
                  '[class*="ButtonPost"]'
                ];

                let posted = false;
                for (const sel of sendBtns) {
                  const btn = document.querySelector(sel);
                  if (btn && isVisible(btn)) {
                    btn.click();
                    posted = true;
                    break;
                  }
                }

                if (!posted) {
                  // Fallback: Dispatch Enter key event on input
                  editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                  editable.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                  editable.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                }

                return { success: true };
              } catch(e) {
                return { success: false, error: e.toString() };
              }
            })();
          \`);

          // Send Enter key via Electron input event as safety confirmation
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: commentResult?.success ? 'info' : 'warning',
            message: commentResult?.success
              ? \`💬 Đã nhập và gửi yêu cầu bình luận video: "\${commentText}".\`
              : \`💬 Không nhập được bình luận video cho @\${acc.username}: \${commentResult?.reason || commentResult?.error || 'không rõ lỗi'}.\`,
          });
        }
      }
    } else if (config.targetType === 'livestream') {`;

content = content.replace(oldVideoCommentRegex, newVideoCommentBlock);

fs.writeFileSync(runnerPath, content, 'utf8');
console.log('Successfully patched single-click like and robust React comment insertion!');
