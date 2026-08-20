import { BrowserWindow } from 'electron';
import { TaskLogItem } from '../nest/automation/automation.interface';

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

export async function getLiveTapPoint(win: BrowserWindow, preferButton = false): Promise<{ x: number; y: number; target?: string } | null> {
  if (win.isDestroyed()) return null;

  return win.webContents.executeJavaScript(`
    (() => {
      try {
        const preferButton = ${preferButton ? 'true' : 'false'};
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 &&
                 rect.height > 0 &&
                 style.visibility !== 'hidden' &&
                 style.display !== 'none';
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

        if (preferButton) {
          const button = findRoomLikeButton();
          if (button) {
            const rect = button.getBoundingClientRect();
            return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), target: 'room-like-btn' };
          }
        }

        const scoreSurface = (el) => {
          const rect = el.getBoundingClientRect();
          const centerBias = Math.abs((rect.left + rect.width / 2) - window.innerWidth * 0.42);
          return (rect.width * rect.height) - centerBias * 20;
        };

        const surface = Array.from(document.querySelectorAll(
          'video, canvas, [data-e2e="live-player"], [data-e2e="live-room"], [data-e2e*="live-player"], [class*="LivePlayer"], [class*="live-player"], [class*="DivLive"], [class*="Player"]'
        )).filter(isVisible).sort((a, b) => scoreSurface(b) - scoreSurface(a))[0];

        if (surface) {
          const rect = surface.getBoundingClientRect();
          return {
            x: Math.round(rect.left + rect.width * 0.5),
            y: Math.round(rect.top + rect.height * 0.52),
            target: surface.tagName?.toLowerCase() === 'video' ? 'live-video' : 'live-surface'
          };
        }

        const button = findRoomLikeButton();
        if (button) {
          const rect = button.getBoundingClientRect();
          return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), target: 'room-like-btn' };
        }

        const width = window.innerWidth || document.documentElement.clientWidth || 800;
        const height = window.innerHeight || document.documentElement.clientHeight || 600;
        return { x: Math.round(width * 0.42), y: Math.round(height * 0.5), target: 'screen-fallback' };
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
  const tapTargets: Record<string, number> = {};

  while (Date.now() < endAt && !win.isDestroyed()) {
    const tapPoint = await getLiveTapPoint(win, tapCount % 4 === 3);

    if (tapPoint && typeof tapPoint.x === 'number' && typeof tapPoint.y === 'number') {
      const zoomFactor = win.webContents.getZoomFactor();
      const tapX = Math.max(1, Math.round(tapPoint.x * zoomFactor));
      const tapY = Math.max(1, Math.round(tapPoint.y * zoomFactor));

      win.webContents.sendInputEvent({ type: 'mouseMove', x: tapX, y: tapY });
      win.webContents.sendInputEvent({ type: 'mouseDown', x: tapX, y: tapY, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: tapX, y: tapY, button: 'left', clickCount: 1 });
      tapTargets[tapPoint.target || 'unknown'] = (tapTargets[tapPoint.target || 'unknown'] || 0) + 1;
      tapCount++;
    }

    await new Promise(res => setTimeout(res, 90 + Math.random() * 60));
  }

  const targetSummary = Object.entries(tapTargets)
    .map(([target, count]) => `${target}:${count}`)
    .join(', ');

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: tapCount > 0 ? 'success' : 'warning',
    message: tapCount > 0
      ? `[Live Like:${label}] Tapped live ${tapCount} times in ${liveDurationSeconds}s${targetSummary ? ` (${targetSummary})` : ''}.`
      : `[Live Like:${label}] Khong tim thay vung live/nut tim de tap cho @${acc.username}.`,
  });

  return tapCount;
}
