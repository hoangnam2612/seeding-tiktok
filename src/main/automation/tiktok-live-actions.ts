import { BrowserWindow } from 'electron';
import { SeedingTaskConfig, TaskLogItem } from '../nest/automation/automation.interface';
import { AccountInfo } from './types';
import { throwIfSeedingCancelled, waitForSeedingDelay } from './seeding-control';

export const LIVESTREAM_INITIAL_COMMENT_DELAY_MS = 15000;

export async function activateLiveUiForTapping(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return;

  await win.webContents.executeJavaScript(`
    (() => {
      try {
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 &&
                 rect.height > 0 &&
                 style.visibility !== 'hidden' &&
                 style.display !== 'none';
        };

        const input = Array.from(document.querySelectorAll(
          '[data-e2e="room-chat-input-field"], [data-e2e*="room-chat"], [role="textbox"], div[contenteditable], textarea, input[type="text"]'
        )).find(isVisible);

        if (input) {
          input.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
          input.click();
          input.focus?.();
        }
      } catch(e) {}
    })();
  `).catch(() => undefined);

  await new Promise(res => setTimeout(res, 250));

  if (win.isDestroyed()) return;
  await win.webContents.executeJavaScript(`
    (() => {
      try {
        const active = document.activeElement;
        if (active && active.blur) active.blur();
      } catch(e) {}
    })();
  `).catch(() => undefined);
}

export async function getLiveTapPoint(win: BrowserWindow): Promise<{ x: number; y: number; target?: string } | null> {
  if (win.isDestroyed()) return null;

  return win.webContents.executeJavaScript(`
    (() => {
      try {
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 &&
                 rect.height > 0 &&
                 style.visibility !== 'hidden' &&
                 style.display !== 'none' &&
                 style.opacity !== '0';
        };

        const findRoomLikeButton = () => {
          const exact = document.querySelector('[data-e2e="room-chat-like-btn"]');
          if (exact && isVisible(exact)) return exact;
          return Array.from(document.querySelectorAll('button, [role="button"], [aria-label], [data-e2e]')).find(el => {
            if (!isVisible(el)) return false;
            const label = [
              el.getAttribute('aria-label'),
              el.getAttribute('data-e2e'),
              el.getAttribute('title'),
              el.textContent
            ].join(' ').toLowerCase();
            return label.includes('like') ||
                   label.includes('heart') ||
                   label.includes('thích') ||
                   label.includes('thÃ­ch') ||
                   label.includes('tap');
          });
        };

        const button = findRoomLikeButton();
        if (button) {
          const rect = button.getBoundingClientRect();
          return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            target: 'room-like-btn'
          };
        }

        return null;
      } catch(e) {
        return null;
      }
    })();
  `).catch(() => null);
}

export async function tapLiveContinuously(
  win: BrowserWindow,
  acc: { id: string; username: string },
  liveDurationSeconds: number,
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void,
  label = 'live'
): Promise<number> {
  await activateLiveUiForTapping(win);

  const endAt = Date.now() + liveDurationSeconds * 1000;
  let tapCount = 0;

  while (Date.now() < endAt && !win.isDestroyed()) {
    const tapPoint = await getLiveTapPoint(win);

    if (tapPoint && typeof tapPoint.x === 'number' && typeof tapPoint.y === 'number') {
      const zoomFactor = win.webContents.getZoomFactor();
      const tapX = Math.max(1, Math.round(tapPoint.x * zoomFactor));
      const tapY = Math.max(1, Math.round(tapPoint.y * zoomFactor));

      win.webContents.sendInputEvent({ type: 'mouseMove', x: tapX, y: tapY });
      win.webContents.sendInputEvent({ type: 'mouseDown', x: tapX, y: tapY, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: tapX, y: tapY, button: 'left', clickCount: 1 });
      tapCount++;
    }

    await new Promise(res => setTimeout(res, 90 + Math.random() * 60));
  }

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: tapCount > 0 ? 'success' : 'warning',
    message: tapCount > 0
      ? `[Live Like:${label}] Đã thả tim vào icon tim ${tapCount} lần trong ${liveDurationSeconds}s cho @${acc.username}.`
      : `[Live Like:${label}] Không tìm thấy icon nút tim để tap cho @${acc.username}.`,
  });

  return tapCount;
}

/**
 * Focuses the Live comment / chat input field, types the text and clicks the send button.
 */
export async function focusAndSubmitLiveComment(
  win: BrowserWindow,
  liveCommentText: string,
  acc: AccountInfo,
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void
): Promise<boolean> {
  if (win.isDestroyed() || !liveCommentText.trim()) return false;

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'info',
    message: `Đang tìm ô bình luận Live để gửi: "${liveCommentText}"...`,
  });

  const focusLiveComment = await win.webContents.executeJavaScript(`
    (async () => {
      try {
        const isVisible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };

        const clickByText = (patterns) => {
          const target = Array.from(document.querySelectorAll('button, [role="button"], [aria-label], div, span')).find(el => {
            if (!isVisible(el)) return false;
            const label = [
              el.getAttribute('aria-label'),
              el.getAttribute('data-e2e'),
              el.getAttribute('title'),
              el.textContent
            ].join(' ').toLowerCase();
            return patterns.some(pattern => label.includes(pattern));
          });
          if (target) {
            target.click();
            return true;
          }
          return false;
        };

        const scrollHorizontally = (side) => {
          const maxed = [];
          if (document.scrollingElement) {
            document.scrollingElement.scrollLeft = side === 'right'
              ? document.scrollingElement.scrollWidth
              : 0;
          }
          Array.from(document.querySelectorAll('*'))
            .filter(el => el.scrollWidth > el.clientWidth + 80)
            .slice(0, 12)
            .forEach(el => {
              try {
                el.scrollLeft = side === 'right' ? el.scrollWidth : 0;
                maxed.push(el.tagName);
              } catch(e) {}
            });
          return maxed.length;
        };

        const findInput = () => {
          // Priority 1: Exact selector room-chat-input-field
          const exactInput = document.querySelector('[data-e2e="room-chat-input-field"]');
          if (exactInput && isVisible(exactInput)) return exactInput;

          // Priority 2: General query with contenteditable="plaintext-only" and data-e2e
          const allInputs = Array.from(document.querySelectorAll(
            '[data-e2e="room-chat-input-field"], [data-e2e="comment-input"], textarea, input[type="text"], input:not([type]), div[contenteditable], [role="textbox"], [data-e2e*="comment"], [data-e2e*="chat"]'
          )).filter(el => {
            if (!isVisible(el)) return false;
            const label = [
              el.getAttribute('placeholder'),
              el.getAttribute('aria-label'),
              el.getAttribute('data-e2e'),
              el.getAttribute('class'),
              el.textContent
            ].join(' ').toLowerCase();
            return label.includes('comment') ||
                   label.includes('chat') ||
                   label.includes('message') ||
                   label.includes('say') ||
                   label.includes('bình luận') ||
                   label.includes('nhắn') ||
                   label.includes('write') ||
                   label.includes('input') ||
                   el.tagName === 'TEXTAREA' ||
                   el.hasAttribute('contenteditable') ||
                   el.getAttribute('role') === 'textbox';
          });
          return allInputs.sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return (br.left + br.top) - (ar.left + ar.top);
          })[0] || null;
        };

        clickByText(['comment', 'chat', 'bình luận', 'message']);
        await new Promise(r => setTimeout(r, 500));

        let input = findInput();
        if (!input) {
          scrollHorizontally('right');
          await new Promise(r => setTimeout(r, 500));
          clickByText(['comment', 'chat', 'bình luận', 'message']);
          await new Promise(r => setTimeout(r, 500));
          input = findInput();
        }
        if (!input) {
          scrollHorizontally('left');
          await new Promise(r => setTimeout(r, 300));
          input = findInput();
        }

        const totalInputs = document.querySelectorAll('textarea, input, div[contenteditable], [role="textbox"]').length;
        if (!input) return { success: false, reason: 'Không thấy ô chat/comment Live. Tổng input/textbox trên DOM: ' + totalInputs };

        input.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        await new Promise(r => setTimeout(r, 250));
        input.click();
        input.focus();
        return { success: true };
      } catch(e) {
        return { success: false, reason: e.toString() };
      }
    })();
  `).catch((err) => ({ success: false, reason: String(err) }));

  if (focusLiveComment && focusLiveComment.success) {
    for (const char of liveCommentText) {
      throwIfSeedingCancelled(win);
      win.webContents.sendInputEvent({ type: 'char', keyCode: char });
      await waitForSeedingDelay(35 + Math.random() * 35, win);
    }
    await waitForSeedingDelay(500, win);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

    // Send via room-chat-send-btn if present
    const liveSendResult = await win.webContents.executeJavaScript(`
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
    `).catch(() => ({ clicked: false, error: 'Eval send button failed.' }));

    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: liveSendResult?.clicked ? 'info' : 'warning',
      message: liveSendResult?.clicked
        ? `💬 Đã click nút gửi bình luận Live: "${liveCommentText}". TikTok chưa xác nhận bình luận đã hiển thị.`
        : `Không click được nút gửi Live cho @${acc.username}. Nút gửi: ${liveSendResult?.sendBtnVisible ? 'có hiện' : 'không hiện'}, trạng thái: ${liveSendResult?.isProbablyDisabled ? 'chưa sẵn sàng' : 'không rõ'}, text trong ô: ${liveSendResult?.inputTextLength ?? 0} ký tự.`,
    });
    return !!liveSendResult?.clicked;
  } else {
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'warning',
      message: `Không gửi được bình luận Live cho @${acc.username}: ${focusLiveComment?.reason || 'không tìm thấy ô bình luận'}`,
    });
    return false;
  }
}

/**
 * Orchestrates the full livestream seeding process:
 * 1. Warmup live tapping & initial delay
 * 2. Focus & post live comments (if configured)
 * 3. Continuous live tapping for the configured duration
 */
export async function performLivestreamSeeding(
  win: BrowserWindow,
  acc: AccountInfo,
  config: SeedingTaskConfig,
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void
): Promise<void> {
  const liveDurationSeconds = Math.max(10, config.liveDurationSeconds || 60);

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'info',
    message: `Đang giữ livestream ${liveDurationSeconds}s cho @${acc.username}${config.likeEnabled ? ' và tap live liên tục...' : '...'}`,
  });

  const liveLikeWarmupPromise = config.likeEnabled && config.comments && config.comments.length > 0
    ? tapLiveContinuously(win, acc, Math.min(8, liveDurationSeconds), onLog, 'warmup')
    : Promise.resolve(0);

  if (config.comments && config.comments.length > 0) {
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'info',
      message: `⏳ Vừa vào Livestream, đang chờ ${Math.round(LIVESTREAM_INITIAL_COMMENT_DELAY_MS / 1000)}s trước khi bắt đầu bình luận cho @${acc.username}...`,
    });
    await waitForSeedingDelay(LIVESTREAM_INITIAL_COMMENT_DELAY_MS, win);
    await liveLikeWarmupPromise.catch(() => 0);
    throwIfSeedingCancelled(win);
  }

  if (!win.isDestroyed()) {
    await waitForSeedingDelay(150, win);
  }
  throwIfSeedingCancelled(win);

  if (config.comments && config.comments.length > 0) {
    const liveCommentText = config.comments[Math.floor(Math.random() * config.comments.length)].trim();
    if (liveCommentText) {
      await focusAndSubmitLiveComment(win, liveCommentText, acc, onLog);
    }
  }

  if (config.likeEnabled) {
    await tapLiveContinuously(win, acc, liveDurationSeconds, onLog, 'main');
  } else {
    await waitForSeedingDelay(liveDurationSeconds * 1000, win);
  }
}
