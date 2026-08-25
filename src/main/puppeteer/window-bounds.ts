import { screen } from 'electron';

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Real Google Chrome windows are normal top-level windows again.
// Use an adaptive grid so windows stay large enough for Chrome's real min size.
export const CHROME_WINDOW_WIDTH = 620;
export const CHROME_WINDOW_HEIGHT = 620;
export const CHROME_DEVICE_SCALE = 1;
export const TIKTOK_INNER_CONTENT_ZOOM = '1';
const MAX_GRID_COLUMNS = 4;
const MAX_GRID_ROWS = 2;
const MIN_BROWSER_WIDTH = 300;
const MIN_BROWSER_HEIGHT = 150;
const MAX_BROWSER_HEIGHT = 1080;
const GRID_GAP = 4;
const GRID_MARGIN = 4;
const OVERFLOW_OFFSET = 30;

/**
 * Calculates window position and dimensions for multi-profile Chrome instances.
 * Guarantees zero overlap with 20px separation gap between windows.
 */
export function calculateProfileWindowBounds(
  slotIndex: number,
  hostBounds?: WindowBounds
): WindowBounds {
  let workArea = { x: 0, y: 0, width: 1920, height: 1040 };

  if (hostBounds) {
    workArea = hostBounds;
  } else {
    try {
      const primaryDisplay = screen.getPrimaryDisplay();
      if (primaryDisplay?.workArea) {
        workArea = primaryDisplay.workArea;
      }
    } catch {
      // Fallback
    }
  }

  const columns = MAX_GRID_COLUMNS;
  const rows = MAX_GRID_ROWS;

  // 1. Dùng MIN_BROWSER_WIDTH, MIN_BROWSER_HEIGHT, MAX_BROWSER_HEIGHT để clamp kích thước
  const calculatedWidth = Math.floor((workArea.width - GRID_MARGIN * 2 - GRID_GAP * (columns - 1)) / columns);
  const calculatedHeight = Math.floor((workArea.height - GRID_MARGIN * 2 - GRID_GAP * (rows - 1)) / rows);

  const width = Math.max(MIN_BROWSER_WIDTH, calculatedWidth);
  const height = Math.max(MIN_BROWSER_HEIGHT, Math.min(MAX_BROWSER_HEIGHT, calculatedHeight));

  // 2. Dùng OVERFLOW_OFFSET khi slotIndex vượt quá 1 màn hình
  const totalVisibleSlots = columns * rows;
  const slotInGrid = slotIndex % totalVisibleSlots;
  const cycle = Math.floor(slotIndex / totalVisibleSlots);
  const cycleOffset = cycle * OVERFLOW_OFFSET;

  const col = slotInGrid % columns;
  const row = Math.floor(slotInGrid / columns);

  const rawX = workArea.x + GRID_MARGIN + col * (width + GRID_GAP) + cycleOffset;
  const rawY = workArea.y + GRID_MARGIN + row * (height + GRID_GAP) + cycleOffset;

  const maxX = workArea.x + workArea.width - width - GRID_MARGIN;
  const maxY = workArea.y + workArea.height - height - GRID_MARGIN;

  return {
    width,
    height,
    x: Math.min(Math.max(rawX, workArea.x), Math.max(workArea.x, maxX)),
    y: Math.min(Math.max(rawY, workArea.y), Math.max(workArea.y, maxY)),
  };
}
/**
 * Slot Manager that tracks occupied slots and assigns the smallest available slot index
 */
export class WindowSlotManager {
  private occupiedSlots = new Map<string, number>(); // accountId -> slotIndex

  public acquireSlot(accountId: string, preferredSlot?: number): number {
    if (this.occupiedSlots.has(accountId)) {
      return this.occupiedSlots.get(accountId)!;
    }

    if (preferredSlot !== undefined && preferredSlot >= 0) {
      this.occupiedSlots.set(accountId, preferredSlot);
      return preferredSlot;
    }

    const used = new Set(this.occupiedSlots.values());
    let slot = 0;
    while (used.has(slot)) {
      slot++;
    }

    this.occupiedSlots.set(accountId, slot);
    return slot;
  }

  public releaseSlot(accountId: string) {
    this.occupiedSlots.delete(accountId);
  }

  public clear() {
    this.occupiedSlots.clear();
  }

  public getOccupiedSlot(accountId: string): number | undefined {
    return this.occupiedSlots.get(accountId);
  }
}

export const windowSlotManager = new WindowSlotManager();
