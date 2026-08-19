const fs = require('fs');
const path = require('path');

const runnerPath = path.join(__dirname, '..', 'src', 'main', 'automation-runner.ts');
let content = fs.readFileSync(runnerPath, 'utf8');

const targetStr = `          if (focusLiveComment && focusLiveComment.success) {
            for (const char of liveCommentText) {
                    sendBtn.click();
                    return {
                      clicked: true,
                      sendBtnVisible,
                      isProbablyDisabled,
                      inputTextLength: inputText.length
                    };
                  }

                  return {
                    clicked: false,
                    sendBtnVisible,
                    isProbablyDisabled,
                    inputTextLength: inputText.length
                  };
                } catch(e) {}
                return { clicked: false, error: 'KhÃ´ng kiá»ƒm tra Ä‘Æ°á»£c nÃºt gá»­i Live.' };
              })();
            \`);

            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: liveSendResult?.clicked ? 'info' : 'warning',
              message: liveSendResult?.clicked
                ? \`ðŸ’¬ Ä Ã£ click nÃºt gá»­i bÃ¬nh luáº­n Live: "\${liveCommentText}". TikTok chÆ°a xÃ¡c nháº­n bÃ¬nh luáº­n Ä‘Ã£ hiá»ƒn thá»‹.\`
                : \`KhÃ´ng click Ä‘Æ°á»£c nÃºt gá»­i Live cho @\${acc.username}. NÃºt gá»­i: \${liveSendResult?.sendBtnVisible ? 'cÃ³ hiá»‡n' : 'khÃ´ng hiá»‡n'}, tráº¡ng thÃ¡i: \${liveSendResult?.isProbablyDisabled ? 'chÆ°a sáºµn sÃ ng' : 'khÃ´ng rÃµ'}, text trong Ã´: \${liveSendResult?.inputTextLength ?? 0} kÃ½ tá»±.\`,
            });
          } else {
            onLog({`;

const replaceStr = `          if (focusLiveComment && focusLiveComment.success) {
            for (const char of liveCommentText) {
              throwIfSeedingCancelled(win);
              win.webContents.sendInputEvent({ type: 'char', keyCode: char });
              await waitForSeedingDelay(35 + Math.random() * 35, win);
            }
            await waitForSeedingDelay(500, win);
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

            // Send via room-chat-send-btn if present
            const liveSendResult = await win.webContents.executeJavaScript(\`
              (() => {
                try {
                  const sendBtn = document.querySelector('[data-e2e="room-chat-send-btn"]');
                  const input = document.querySelector('[data-e2e="room-chat-input-field"]');
                  const inputText = (input?.textContent || input?.innerText || '').trim();
                  const sendBtnVisible = !!sendBtn && sendBtn.offsetWidth > 0 && sendBtn.offsetHeight > 0;
                  const sendBtnClass = sendBtn?.getAttribute('class') || '';
                  const isProbablyDisabled = sendBtnClass.includes('invisible') ||
                                            sendBtnClass.includes('cursor-not-allowed') ||
                                            sendBtn?.getAttribute('aria-disabled') === 'true';

                  if (sendBtnVisible && !isProbablyDisabled) {
                    sendBtn.click();
                    return {
                      clicked: true,
                      sendBtnVisible,
                      isProbablyDisabled,
                      inputTextLength: inputText.length
                    };
                  }

                  return {
                    clicked: false,
                    sendBtnVisible,
                    isProbablyDisabled,
                    inputTextLength: inputText.length
                  };
                } catch(e) {}
                return { clicked: false, error: 'Không kiểm tra được nút gửi Live.' };
              })();
            \`);

            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: liveSendResult?.clicked ? 'info' : 'warning',
              message: liveSendResult?.clicked
                ? \`💬 Đã click nút gửi bình luận Live: "\${liveCommentText}". TikTok chưa xác nhận bình luận đã hiển thị.\`
                : \`Không click được nút gửi Live cho @\${acc.username}. Nút gửi: \${liveSendResult?.sendBtnVisible ? 'có hiện' : 'không hiện'}, trạng thái: \${liveSendResult?.isProbablyDisabled ? 'chưa sẵn sàng' : 'không rõ'}, text trong ô: \${liveSendResult?.inputTextLength ?? 0} ký tự.\`,
            });
          } else {
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'warning',
              message: \`Không gửi được bình luận Live cho @\${acc.username}: \${focusLiveComment?.reason || 'không tìm thấy ô bình luận'}\`,
            });
          }
        }
      }

      if (config.likeEnabled) {
        await tapLiveContinuously(win, acc, liveDurationSeconds, onLog, 'main');
      } else {
        await waitForSeedingDelay(liveDurationSeconds * 1000, win);
      }
    }`;

content = content.replace(targetStr, replaceStr);
fs.writeFileSync(runnerPath, content, 'utf8');
console.log('Fixed syntax successfully!');
