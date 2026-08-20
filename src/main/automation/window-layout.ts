import { BrowserWindow, screen } from 'electron';

const TILED_LOGIN_TARGET_WIDTH = 430;
const TILED_LOGIN_TARGET_HEIGHT = 320;
const TILED_LOGIN_MIN_WIDTH = 420;
const TILED_LOGIN_MIN_HEIGHT = 300;
const TILED_LOGIN_GAP = 6;
const TILED_LOGIN_OVERFLOW_OFFSET = 24;
const TILED_SEEDING_TARGET_WIDTH = 430;
const TILED_SEEDING_TARGET_HEIGHT = 320;
const TILED_SEEDING_MIN_WIDTH = 420;
const TILED_SEEDING_MIN_HEIGHT = 300;
const TILED_VIDEO_COMMENT_TARGET_WIDTH = TILED_SEEDING_TARGET_WIDTH;
const TILED_VIDEO_COMMENT_TARGET_HEIGHT = TILED_SEEDING_TARGET_HEIGHT;
export const TILED_VIDEO_COMMENT_MIN_WIDTH = TILED_SEEDING_MIN_WIDTH;
export const TILED_VIDEO_COMMENT_MIN_HEIGHT = TILED_SEEDING_MIN_HEIGHT;
export const TIKTOK_SEEDING_ZOOM = 0.52;

export function getTiledLoginWindowBounds(slotIndex: number) {
  const workArea = screen.getPrimaryDisplay().workArea;
  const columns = Math.max(1, Math.floor((workArea.width + TILED_LOGIN_GAP) / (TILED_LOGIN_TARGET_WIDTH + TILED_LOGIN_GAP)));
  const rows = Math.max(1, Math.floor((workArea.height + TILED_LOGIN_GAP) / (TILED_LOGIN_TARGET_HEIGHT + TILED_LOGIN_GAP)));
  const width = Math.max(
    TILED_LOGIN_MIN_WIDTH,
    Math.floor((workArea.width - TILED_LOGIN_GAP * (columns + 1)) / columns)
  );
  const height = Math.max(
    TILED_LOGIN_MIN_HEIGHT,
    Math.floor((workArea.height - TILED_LOGIN_GAP * (rows + 1)) / rows)
  );
  const visibleSlots = Math.max(1, columns * rows);
  const wrappedIndex = slotIndex % visibleSlots;
  const overflowRound = Math.floor(slotIndex / visibleSlots);
  const col = wrappedIndex % columns;
  const row = Math.floor(wrappedIndex / columns);
  const overflowOffset = overflowRound * TILED_LOGIN_OVERFLOW_OFFSET;
  const rawX = workArea.x + TILED_LOGIN_GAP + col * (width + TILED_LOGIN_GAP) + overflowOffset;
  const rawY = workArea.y + TILED_LOGIN_GAP + row * (height + TILED_LOGIN_GAP) + overflowOffset;
  const maxX = workArea.x + workArea.width - width - TILED_LOGIN_GAP;
  const maxY = workArea.y + workArea.height - height - TILED_LOGIN_GAP;

  return {
    width,
    height,
    x: Math.min(Math.max(rawX, workArea.x + TILED_LOGIN_GAP), maxX),
    y: Math.min(Math.max(rawY, workArea.y + TILED_LOGIN_GAP), maxY),
  };
}

export function getTiledSeedingWindowBounds(slotIndex: number, preferVideoCommentLayout = false) {
  const workArea = screen.getPrimaryDisplay().workArea;
  const targetWidth = preferVideoCommentLayout ? TILED_VIDEO_COMMENT_TARGET_WIDTH : TILED_SEEDING_TARGET_WIDTH;
  const targetHeight = preferVideoCommentLayout ? TILED_VIDEO_COMMENT_TARGET_HEIGHT : TILED_SEEDING_TARGET_HEIGHT;
  const minWidth = preferVideoCommentLayout ? TILED_VIDEO_COMMENT_MIN_WIDTH : TILED_SEEDING_MIN_WIDTH;
  const minHeight = preferVideoCommentLayout ? TILED_VIDEO_COMMENT_MIN_HEIGHT : TILED_SEEDING_MIN_HEIGHT;
  const columns = Math.max(1, Math.floor((workArea.width + TILED_LOGIN_GAP) / (targetWidth + TILED_LOGIN_GAP)));
  const rows = Math.max(1, Math.floor((workArea.height + TILED_LOGIN_GAP) / (targetHeight + TILED_LOGIN_GAP)));
  const width = Math.max(
    minWidth,
    Math.floor((workArea.width - TILED_LOGIN_GAP * (columns + 1)) / columns)
  );
  const height = Math.max(
    minHeight,
    Math.floor((workArea.height - TILED_LOGIN_GAP * (rows + 1)) / rows)
  );
  const visibleSlots = Math.max(1, columns * rows);
  const wrappedIndex = slotIndex % visibleSlots;
  const overflowRound = Math.floor(slotIndex / visibleSlots);
  const col = wrappedIndex % columns;
  const row = Math.floor(wrappedIndex / columns);
  const overflowOffset = overflowRound * TILED_LOGIN_OVERFLOW_OFFSET;
  const rawX = workArea.x + TILED_LOGIN_GAP + col * (width + TILED_LOGIN_GAP) + overflowOffset;
  const rawY = workArea.y + TILED_LOGIN_GAP + row * (height + TILED_LOGIN_GAP) + overflowOffset;
  const maxX = workArea.x + workArea.width - width - TILED_LOGIN_GAP;
  const maxY = workArea.y + workArea.height - height - TILED_LOGIN_GAP;

  return {
    width,
    height,
    x: Math.min(Math.max(rawX, workArea.x + TILED_LOGIN_GAP), maxX),
    y: Math.min(Math.max(rawY, workArea.y + TILED_LOGIN_GAP), maxY),
  };
}

export function applyTikTokSeedingZoom(win: BrowserWindow) {
  if (win.isDestroyed()) return;

  try {
    const currentZoom = win.webContents.getZoomFactor();
    if (Math.abs(currentZoom - TIKTOK_SEEDING_ZOOM) > 0.001) {
      win.webContents.setZoomFactor(TIKTOK_SEEDING_ZOOM);
    }
  } catch {}
}

export function keepTikTokSeedingZoom(win: BrowserWindow) {
  const contents = win.webContents;
  const reapplyZoom = () => {
    setTimeout(() => applyTikTokSeedingZoom(win), 0);
    setTimeout(() => applyTikTokSeedingZoom(win), 500);
  };

  applyTikTokSeedingZoom(win);
  contents.on('did-start-navigation', reapplyZoom);
  contents.on('dom-ready', reapplyZoom);
  contents.on('did-finish-load', reapplyZoom);
  contents.on('did-navigate-in-page', reapplyZoom);

  win.on('closed', () => {
    try {
      if (contents.isDestroyed()) return;
      contents.removeListener('did-start-navigation', reapplyZoom);
      contents.removeListener('dom-ready', reapplyZoom);
      contents.removeListener('did-finish-load', reapplyZoom);
      contents.removeListener('did-navigate-in-page', reapplyZoom);
    } catch {}
  });
}
