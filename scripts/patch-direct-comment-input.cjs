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

                // 1. Check if comment input area is available on page
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
                    target = matches[matches.length - 1]; // bottom-most input element
                    break;
                  }
                }

                // If not found directly, check placeholder matches
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
console.log('Successfully patched direct comment input typing without any icon clicks!');
