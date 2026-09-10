import { screen } from 'electron';
import { getStoredAppSettings } from '../nest/app.service';

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CalculateBoundsOptions {
  width?: number;
  height?: number;
  maxColumns?: number;
}

// Default Google Chrome window dimensions (Mobile-like proportion similar to MKT TikPro)
export const CHROME_WINDOW_WIDTH = 360;
export const CHROME_WINDOW_HEIGHT = 480;
export const CHROME_DEVICE_SCALE = 0.65;
export const TIKTOK_INNER_CONTENT_ZOOM = '0.75';
const DEFAULT_MAX_GRID_COLUMNS = 4;
const MIN_BROWSER_WIDTH = 240;
const MIN_BROWSER_HEIGHT = 150;
const GRID_GAP = 8;
const GRID_MARGIN = 4;
const CHROME_LAYOUT_WIDTH_PADDING = 10;
const CHROME_LAYOUT_HEIGHT_PADDING = 10;

/**
 * Calculates window position and dimensions for multi-profile Chrome instances.
 * Dynamically uses the configured browser size and column count from settings.
 */
export function calculateProfileWindowBounds(
  slotIndex: number,
  options?: CalculateBoundsOptions
): WindowBounds {
  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay?.workArea;

  if (!workArea) {
    throw new Error('Unable to determine primary display work area.');
  }

  const settings = getStoredAppSettings();
  const targetWidth = options?.width || settings.chromeWindowWidth || CHROME_WINDOW_WIDTH;
  const targetHeight = options?.height || settings.chromeWindowHeight || CHROME_WINDOW_HEIGHT;
  const maxGridColumns = Math.max(1, options?.maxColumns || settings.chromeGridColumns || DEFAULT_MAX_GRID_COLUMNS);

  const availableWidth = Math.max(MIN_BROWSER_WIDTH, workArea.width - GRID_MARGIN * 2);
  const availableHeight = Math.max(MIN_BROWSER_HEIGHT, workArea.height - GRID_MARGIN * 2);

  const width = Math.max(MIN_BROWSER_WIDTH, Math.min(targetWidth, availableWidth));
  const height = Math.max(MIN_BROWSER_HEIGHT, Math.min(targetHeight, availableHeight));
  const layoutWidth = Math.min(availableWidth, width + CHROME_LAYOUT_WIDTH_PADDING);
  const layoutHeight = Math.min(availableHeight, height + CHROME_LAYOUT_HEIGHT_PADDING);

  const columns = Math.max(
    1,
    Math.min(
      maxGridColumns,
      Math.floor((availableWidth + GRID_GAP) / (layoutWidth + GRID_GAP))
    )
  );
  const rows = Math.max(
    1,
    Math.floor((availableHeight + GRID_GAP) / (layoutHeight + GRID_GAP))
  );

  const totalVisibleSlots = Math.max(1, columns * rows);
  const slotInGrid = slotIndex % totalVisibleSlots;

  const col = slotInGrid % columns;
  const row = Math.floor(slotInGrid / columns);

  const rawX = workArea.x + GRID_MARGIN + col * (layoutWidth + GRID_GAP);
  const rawY = workArea.y + GRID_MARGIN + row * (layoutHeight + GRID_GAP);

  const maxX = workArea.x + workArea.width - layoutWidth - GRID_MARGIN;
  const maxY = workArea.y + workArea.height - layoutHeight - GRID_MARGIN;

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
