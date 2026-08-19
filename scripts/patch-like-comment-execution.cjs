const fs = require('fs');
const path = require('path');

const runnerPath = path.join(__dirname, '..', 'src', 'main', 'automation-runner.ts');
let content = fs.readFileSync(runnerPath, 'utf8');

// 1. Remove runSeedingInteraction wrapper bottleneck
content = content.replace(/await runSeedingInteraction\(async \(\) => \{/g, '/* direct execution */ {');
content = content.replace(/\}\);\s*\n\s*await persistFreshTikTokSession/g, '}\n      await persistFreshTikTokSession');

// 2. Patch Like action to perform direct DOM click + CDP click
const oldLikeDispatchRegex = /if \(likeTarget\.target === 'video-dblclick'\) \{[\s\S]*?likeResult = \{ attempted: true, verified: false, alreadyLiked: false, target: likeTarget\.target, attempt \};[\s\S]*?await new Promise\(res => setTimeout\(res, 700\)\);[\s\S]*?\}/m;

const newLikeDispatchCode = `// Direct DOM click + CDP click
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

          await performCdpClick(win, likeTarget.x, likeTarget.y).catch(() => {});

          let likeStateAfterClick: any = { liked: false };
          for (const waitMs of [500, 800, 1000]) {
            await new Promise(res => setTimeout(res, waitMs));
            likeStateAfterClick = await readVideoLikeState();
            if (likeStateAfterClick?.liked) {
              likeResult = { attempted: true, verified: true, alreadyLiked: false, target: likeTarget.target, attempt };
              break;
            }
          }

          if (likeResult?.verified) {
            break;
          }

          likeResult = { attempted: true, verified: false, alreadyLiked: false, target: likeTarget.target, attempt };
          await new Promise(res => setTimeout(res, 500));
        }`;

content = content.replace(oldLikeDispatchRegex, newLikeDispatchCode);

// 3. Patch Comment submission to use execCommand/CDP for reliable typing without focus lock
const oldCommentInputRegex = /if \(focusResult && focusResult\.success\) \{[\s\S]*?win\.webContents\.sendInputEvent\(\{ type: 'keyUp', keyCode: 'Enter' \}\);/m;

const newCommentInputCode = `if (focusResult && focusResult.success) {
            await waitForSeedingDelay(400, win);

            // Type text reliably using DOM execCommand + CDP
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

            await waitForSeedingDelay(800, win);

            // Click the Post / Send button or press Enter
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
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });`;

content = content.replace(oldCommentInputRegex, newCommentInputCode);

fs.writeFileSync(runnerPath, content, 'utf8');
console.log('Successfully patched Like, Comment & non-blocking execution in automation-runner.ts!');
