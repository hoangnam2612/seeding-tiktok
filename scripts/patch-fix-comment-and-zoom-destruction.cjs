const fs = require('fs');
const path = require('path');

const runnerPath = path.join(__dirname, '..', 'src', 'main', 'automation-runner.ts');
let content = fs.readFileSync(runnerPath, 'utf8');

// 1. Fix applyTikTokSeedingZoom & keepTikTokSeedingZoom to never throw "Object has been destroyed"
const oldZoomBlockRegex = /function applyTikTokSeedingZoom\([\s\S]*?function keepTikTokSeedingZoom\([\s\S]*?\}\n\}/m;

const newZoomBlock = `function applyTikTokSeedingZoom(win: BrowserWindow) {
  if (!win || win.isDestroyed()) return;
  try {
    const contents = win.webContents;
    if (!contents || contents.isDestroyed()) return;
    const currentZoom = contents.getZoomFactor();
    if (Math.abs(currentZoom - TIKTOK_SEEDING_ZOOM) > 0.001) {
      contents.setZoomFactor(TIKTOK_SEEDING_ZOOM);
    }
  } catch {}
}

function keepTikTokSeedingZoom(win: BrowserWindow) {
  if (!win || win.isDestroyed()) return;
  try {
    const contents = win.webContents;
    if (!contents || contents.isDestroyed()) return;

    const reapplyZoom = () => {
      if (!win || win.isDestroyed()) return;
      try {
        if (win.webContents && !win.webContents.isDestroyed()) {
          applyTikTokSeedingZoom(win);
        }
      } catch {}
    };

    applyTikTokSeedingZoom(win);
    contents.on('did-start-navigation', reapplyZoom);
    contents.on('dom-ready', reapplyZoom);
    contents.on('did-finish-load', reapplyZoom);
    contents.on('did-navigate-in-page', reapplyZoom);
  } catch {}
}`;

content = content.replace(oldZoomBlockRegex, newZoomBlock);

// 2. Fix Video Commenting to never click side comment-icon on video detail pages and directly focus & type in comment box
const oldCommentBlockRegex = /if \(config\.comments && config\.comments\.length > 0\) \{\s*const commentText = config\.comments\[Math\.floor\(Math\.random\(\) \* config\.comments\.length\)\]\.trim\(\);[\s\S]*?\}\s*\}\s*\} else if \(config\.targetType === 'livestream'\) \{/m;

const newCommentBlock = `if (config.comments && config.comments.length > 0) {
        const commentText = config.comments[Math.floor(Math.random() * config.comments.length)].trim();
        if (commentText) {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: \`Đang tự động gõ bình luận: "\${commentText}"...\`,
          });

          await waitForSeedingDelay(1000, win);

          const commentResult = await win.webContents.executeJavaScript(\`
            (async () => {
              try {
                const isVisible = (el) => {
                  if (!el) return false;
                  const rect = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };

                // 1. Check for comment input selectors
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
                  'textarea',
                  'input[placeholder*="comment" i]',
                  'input[placeholder*="bình luận" i]'
                ];

                // Scroll right column container to bottom to reveal comment box if needed
                const commentContainers = document.querySelectorAll(
                  '[data-e2e="video-detail-container"], div[class*="CommentContainer"], div[class*="DivCommentListContainer"], div[class*="DivRightContainer"], div[class*="DivContentContainer"]'
                );
                commentContainers.forEach(c => {
                  try { c.scrollTop = c.scrollHeight; } catch(e) {}
                });

                let input = inputSelectors.map(sel => document.querySelector(sel)).find(isVisible);

                // If not found directly, find any element with placeholder / aria-label matching comment
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

                // Find editable child if input was a container wrapper
                const editableInput = input.getAttribute('contenteditable') ? input :
                  (input.querySelector('[contenteditable], [role="textbox"], textarea, input') || input);

                editableInput.focus();
                document.execCommand('insertText', false, \${JSON.stringify(commentText)});
                editableInput.dispatchEvent(new Event('input', { bubbles: true }));
                editableInput.dispatchEvent(new Event('change', { bubbles: true }));

                await new Promise(r => setTimeout(r, 500));

                // Click Post / Send button
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

                for (const sel of sendBtns) {
                  const btn = document.querySelector(sel);
                  if (btn && isVisible(btn)) {
                    btn.click();
                    const rect = btn.getBoundingClientRect();
                    return {
                      success: true,
                      method: 'post-button',
                      postX: Math.round(rect.left + rect.width / 2),
                      postY: Math.round(rect.top + rect.height / 2)
                    };
                  }
                }

                return { success: true, method: 'enter-key' };
              } catch(e) {
                return { success: false, error: e.toString() };
              }
            })();
          \`);

          if (commentResult?.postX && commentResult?.postY) {
            await performCdpClick(win, commentResult.postX, commentResult.postY).catch(() => {});
          } else if (commentResult?.success) {
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
          }

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

content = content.replace(oldCommentBlockRegex, newCommentBlock);

fs.writeFileSync(runnerPath, content, 'utf8');
console.log('Successfully patched comment & zoom lifecycle destruction fixes!');
