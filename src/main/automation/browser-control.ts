import { BrowserWindow } from 'electron';

const CDP_VERSION = '1.3';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function attachDebuggerIfNeeded(win: BrowserWindow): Promise<void> {
  if (win.webContents.debugger.isAttached()) return;

  try {
    win.webContents.debugger.attach(CDP_VERSION);
  } catch {}
}

export async function performCdpDrag(
  win: BrowserWindow,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  steps = 35
): Promise<void> {
  await attachDebuggerIfNeeded(win);

  try {
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startX,
      y: startY,
    });
    await delay(60);

    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: startX,
      y: startY,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await delay(80);

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = 1 - Math.pow(1 - t, 3);
      const curX = Math.round(startX + (endX - startX) * ease + (Math.random() * 2 - 1));
      const curY = Math.round(startY + (endY - startY) * t + (Math.random() * 2 - 1));
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: curX,
        y: curY,
        button: 'left',
        buttons: 1,
      });
      await delay(14 + Math.random() * 16);
    }

    await delay(80);
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: endX,
      y: endY,
      button: 'left',
      buttons: 0,
    });
  } catch {
    try {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: startX, y: startY });
      win.webContents.sendInputEvent({ type: 'mouseDown', x: startX, y: startY, button: 'left', clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        const curX = Math.round(startX + (endX - startX) * (i / steps));
        win.webContents.sendInputEvent({ type: 'mouseMove', x: curX, y: startY });
        await delay(15);
      }
      win.webContents.sendInputEvent({ type: 'mouseUp', x: endX, y: endY, button: 'left', clickCount: 1 });
    } catch {}
  }
}

export async function performCdpClick(win: BrowserWindow, x: number, y: number): Promise<void> {
  await attachDebuggerIfNeeded(win);

  try {
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    });
    await delay(60);

    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await delay(80);

    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
    });
    await delay(300);
  } catch {
    try {
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    } catch {}
  }
}

export async function performZoomAwareElectronClick(win: BrowserWindow, x: number, y: number): Promise<void> {
  try {
    const zoomFactor = win.webContents.getZoomFactor() || 1;
    const clickX = Math.max(1, Math.round(x * zoomFactor));
    const clickY = Math.max(1, Math.round(y * zoomFactor));
    win.webContents.sendInputEvent({ type: 'mouseMove', x: clickX, y: clickY });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: clickX, y: clickY, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: clickX, y: clickY, button: 'left', clickCount: 1 });
    await delay(300);
  } catch {
    await performCdpClick(win, x, y).catch(() => {});
  }
}

export async function performCdpInsertText(win: BrowserWindow, text: string): Promise<boolean> {
  if (!text || win.isDestroyed()) return false;

  await attachDebuggerIfNeeded(win);

  try {
    await win.webContents.debugger.sendCommand('Input.insertText', { text });
    return true;
  } catch {
    try {
      for (const char of text) {
        win.webContents.sendInputEvent({ type: 'char', keyCode: char });
        await delay(18);
      }
      return true;
    } catch {
      return false;
    }
  }
}
