import { BrowserWindow } from 'electron';

const SEEDING_ACTION_CONCURRENCY = 3;

let activeSeedingInteractions = 0;
const pendingSeedingInteractions: Array<() => void> = [];
let sessionPreparationQueue = Promise.resolve();
let currentSeedingRun: { cancelRequested: boolean; reason?: string } | null = null;

export class SeedingCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedingCancelledError';
  }
}

export function startSeedingRun() {
  currentSeedingRun = { cancelRequested: false };
}

export function finishSeedingRun() {
  currentSeedingRun = null;
}

export function requestSeedingCancel(reason: string) {
  if (currentSeedingRun && !currentSeedingRun.cancelRequested) {
    currentSeedingRun.cancelRequested = true;
    currentSeedingRun.reason = reason;
  }
}

export function isSeedingCancelRequested(): boolean {
  return !!currentSeedingRun?.cancelRequested;
}

export function getSeedingCancelReason(): string | undefined {
  return currentSeedingRun?.reason;
}

export function throwIfSeedingCancelled(win?: BrowserWindow) {
  if (isSeedingCancelRequested()) {
    throw new SeedingCancelledError(currentSeedingRun?.reason || 'Seeding task was cancelled.');
  }
  if (win?.isDestroyed()) {
    throw new SeedingCancelledError('Seeding browser window was closed.');
  }
}

export function waitForSeedingDelay(ms: number, win?: BrowserWindow): Promise<void> {
  throwIfSeedingCancelled(win);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(cleanupAndResolve, ms);

    const onClosed = () => {
      cleanup();
      reject(new SeedingCancelledError('Seeding browser window was closed.'));
    };

    function cleanup() {
      clearTimeout(timer);
      win?.removeListener('closed', onClosed);
    }

    function cleanupAndResolve() {
      cleanup();
      try {
        throwIfSeedingCancelled(win);
        resolve();
      } catch (err) {
        reject(err);
      }
    }

    win?.once('closed', onClosed);
  });
}

export async function runSeedingInteraction<T>(task: () => Promise<T>): Promise<T> {
  if (activeSeedingInteractions >= SEEDING_ACTION_CONCURRENCY) {
    await new Promise<void>(resolve => pendingSeedingInteractions.push(resolve));
  }
  activeSeedingInteractions++;
  try {
    return await task();
  } finally {
    activeSeedingInteractions = Math.max(0, activeSeedingInteractions - 1);
    const next = pendingSeedingInteractions.shift();
    if (next) next();
  }
}

export async function runSessionPreparation<T>(task: () => Promise<T>): Promise<T> {
  const previous = sessionPreparationQueue;
  let release!: () => void;
  sessionPreparationQueue = new Promise<void>(resolve => {
    release = resolve;
  });

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
  }
}
