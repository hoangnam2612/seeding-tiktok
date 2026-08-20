const fs = require('fs');
const path = require('path');

const runnerPath = path.join(__dirname, '..', 'src', 'main', 'automation-runner.ts');
let content = fs.readFileSync(runnerPath, 'utf8');

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

          await waitForSeedingDelay(1000, win);

          // Step 1 & 2: Detect if input is already visible, or find the comment icon to open comment drawer
          const commentOpenResult = await win.webContents.executeJavaScript(\`
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

                let input = inputSelectors.map(sel => document.querySelector(sel)).find(isVisible);
                if (input) return { inputAlreadyVisible: true };

                // If input is not visible, find the comment icon on the video action bar
                const iconSelectors = [
                  '[data-e2e="comment-icon"]',
                  '[data-e2e="browse-comment-icon"]',
                  '[data-e2e="feed-comment-icon"]',
                  '[data-e2e="video-comment-icon"]',
                  'button[aria-label*="comment" i]',
                  'button[aria-label*="bình luận" i]',
                  'button[aria-label*="Bình luận" i]',
                  'span[aria-label*="comment" i]',
                  'span[aria-label*="bình luận" i]',
                  '[role="button"][aria-label*="comment" i]',
                  'strong[data-e2e*="comment-count"]',
                  '[class*="CommentButton"]',
                  '[class*="ButtonActionItem"]'
                ];

                let iconEl = null;
                for (const sel of iconSelectors) {
                  const matches = Array.from(document.querySelectorAll(sel)).filter(isVisible);
                  if (matches.length > 0) {
                    iconEl = matches[0].closest('button') || matches[0].closest('[role="button"]') || matches[0];
                    break;
                  }
                }

                // If still not found, check next sibling of the Like button
                if (!iconEl) {
                  const likeEl = document.querySelector('[data-e2e="like-icon"], [data-e2e="browse-like-icon"], button[aria-label*="like" i]');
                  if (likeEl) {
                    const likeContainer = likeEl.closest('button')?.parentElement || likeEl.parentElement;
                    const nextContainer = likeContainer?.nextElementSibling;
                    const btn = nextContainer?.querySelector('button, [role="button"]') || nextContainer;
                    if (btn && isVisible(btn)) {
                      iconEl = btn;
                    }
                  }
                }

                if (iconEl) {
                  iconEl.click();
                  const rect = iconEl.getBoundingClientRect();
                  return {
                    inputAlreadyVisible: false,
                    openedIcon: true,
                    clickX: Math.round(rect.left + rect.width / 2),
                    clickY: Math.round(rect.top + rect.height / 2)
                  };
                }

                return { inputAlreadyVisible: false, openedIcon: false, reason: 'Không tìm thấy ô nhập hoặc biểu tượng bình luận' };
              } catch(e) {
                return { inputAlreadyVisible: false, openedIcon: false, error: e.toString() };
              }
            })();
          \`);

          if (!commentOpenResult?.inputAlreadyVisible && commentOpenResult?.openedIcon) {
            if (commentOpenResult.clickX && commentOpenResult.clickY) {
              await performCdpClick(win, commentOpenResult.clickX, commentOpenResult.clickY).catch(() => {});
            }
            await waitForSeedingDelay(1500, win);
          }

          // Step 3 & 4: Focus input, type comment, and click Post
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

                // Scroll right sidebar to bottom to reveal comment box
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
                  return { success: false, reason: 'Không tìm thấy ô nhập bình luận sau khi mở tab' };
                }

                input.scrollIntoView({ behavior: 'instant', block: 'center' });
                await new Promise(r => setTimeout(r, 200));

                input.click();
                input.focus();
                await new Promise(r => setTimeout(r, 200));

                const editable = input.getAttribute('contenteditable') ? input :
                  (input.querySelector('[contenteditable], [role="textbox"], textarea, input') || input);

                editable.focus();

                // Select existing content if any and insert text
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

                try {
                  editable.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    cancelable: true,
                    inputType: 'insertText',
                    data: \${JSON.stringify(commentText)}
                  }));
                } catch(e) {}

                await new Promise(r => setTimeout(r, 600));

                // Click Post button
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

          // Send Enter key as final confirmation
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: commentResult?.success ? 'info' : 'warning',
            message: commentResult?.success
              ? \`💬 Đã nhập và gửi yêu cầu bình luận video: "\${commentText}".\`
              : \`💬 Không nhập được bình luận video cho @\${acc.username}: \${commentResult?.reason || commentResult?.error || commentOpenResult?.reason || 'không rõ lỗi'}.\`,
          });
        }
      }
    } else if (config.targetType === 'livestream') {`;

content = content.replace(oldVideoCommentRegex, newVideoCommentBlock);

fs.writeFileSync(runnerPath, content, 'utf8');
console.log('Successfully patched comment icon fallback for feed and detail views!');
