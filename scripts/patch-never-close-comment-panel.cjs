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

          // Step 1: Check if right comment sidebar is open or if we need to open it
          const openState = await win.webContents.executeJavaScript(\`
            (async () => {
              try {
                const isVisible = (el) => {
                  if (!el) return false;
                  const rect = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };

                // Check if right comment panel is already open
                const rightPanelSelectors = [
                  '[data-e2e="video-detail-container"]',
                  'div[class*="DivCommentContainer"]',
                  'div[class*="DivRightContainer"]',
                  'div[class*="DivContentContainer"]',
                  'div[class*="CommentListContainer"]'
                ];
                const isPanelAlreadyOpen = rightPanelSelectors.some(sel => {
                  const el = document.querySelector(sel);
                  return el && isVisible(el) && el.getBoundingClientRect().width >= 200;
                });

                if (isPanelAlreadyOpen) {
                  return { panelOpen: true, actionTaken: 'already_open' };
                }

                // If panel is NOT open (Feed mode), click comment icon once to open it
                const iconSelectors = [
                  '[data-e2e="comment-icon"]',
                  '[data-e2e="browse-comment-icon"]',
                  '[data-e2e="feed-comment-icon"]',
                  '[data-e2e="video-comment-icon"]',
                  'button[aria-label*="comment" i]',
                  'button[aria-label*="bình luận" i]',
                  'button[aria-label*="Bình luận" i]',
                  'strong[data-e2e*="comment-count"]'
                ];

                for (const sel of iconSelectors) {
                  const icon = Array.from(document.querySelectorAll(sel)).find(isVisible);
                  if (icon) {
                    const btn = icon.closest('button') || icon.closest('[role="button"]') || icon;
                    btn.click();
                    const rect = btn.getBoundingClientRect();
                    return {
                      panelOpen: false,
                      actionTaken: 'clicked_icon',
                      clickX: Math.round(rect.left + rect.width / 2),
                      clickY: Math.round(rect.top + rect.height / 2)
                    };
                  }
                }

                return { panelOpen: false, actionTaken: 'none' };
              } catch(e) {
                return { panelOpen: false, error: e.toString() };
              }
            })();
          \`);

          if (openState?.actionTaken === 'clicked_icon') {
            await waitForSeedingDelay(1500, win);
          }

          // Step 2: Locate input area, scroll to it, insert text and submit
          const commentResult = await win.webContents.executeJavaScript(\`
            (async () => {
              try {
                const isVisible = (el) => {
                  if (!el) return false;
                  const rect = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };

                // Scroll right sidebar to bottom to reveal comment box
                const rightPanels = document.querySelectorAll(
                  '[data-e2e="video-detail-container"], div[class*="CommentContainer"], div[class*="DivCommentListContainer"], div[class*="DivRightContainer"], div[class*="DivContentContainer"], main'
                );
                rightPanels.forEach(p => {
                  try { p.scrollTop = p.scrollHeight; } catch(e) {}
                });

                // Find input target
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
                  'div[class*="CommentInput"]',
                  'textarea'
                ];

                let target = null;
                for (const sel of inputSelectors) {
                  const matches = Array.from(document.querySelectorAll(sel)).filter(isVisible);
                  if (matches.length > 0) {
                    target = matches[matches.length - 1]; // pick the bottom-most input area
                    break;
                  }
                }

                if (!target) {
                  const fallbackBox = Array.from(document.querySelectorAll('div, p, span, textarea, input')).filter(el => {
                    if (!isVisible(el)) return false;
                    const ph = (el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('aria-label') || '').toLowerCase();
                    return ph.includes('comment') || ph.includes('bình luận') || ph.includes('add comment') || ph.includes('thêm bình luận');
                  });
                  target = fallbackBox[0];
                }

                if (!target) {
                  return { success: false, reason: 'Không tìm thấy ô nhập bình luận' };
                }

                target.scrollIntoView({ behavior: 'instant', block: 'center' });
                await new Promise(r => setTimeout(r, 150));

                target.click();
                target.focus();
                await new Promise(r => setTimeout(r, 200));

                // Find the editable node inside
                const editable = target.getAttribute('contenteditable') ? target :
                  (target.querySelector('[contenteditable], [role="textbox"], textarea, input') || target);

                editable.focus();

                // Clear & insert text
                try {
                  const sel = window.getSelection();
                  const range = document.createRange();
                  range.selectNodeContents(editable);
                  sel.removeAllRanges();
                  sel.addRange(range);
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
                const postBtns = [
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
                for (const sel of postBtns) {
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

          // Send Enter key as safety confirmation
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
console.log('Successfully patched never-close comment panel logic!');
