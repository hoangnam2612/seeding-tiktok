import { BrowserWindow } from 'electron';
import { SeedingTaskConfig, TaskLogItem } from '../nest/automation/automation.interface';
import { AccountInfo } from './types';
import { performZoomAwareElectronClick, performCdpInsertText } from './browser-control';
import { checkAndSolveAnyCaptcha } from './captcha-solver';

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

export interface FeedCommentClickResult {
  targetFound: boolean;
  clicked: boolean;
  x?: number;
  y?: number;
  reason: string;
  error?: string;
}

/**
 * Finds and clicks the floating comment icon on the TikTok video player.
 */
export async function feedCommentClickTarget(win: BrowserWindow): Promise<FeedCommentClickResult> {
  return await win.webContents.executeJavaScript(`
    (() => {
      try {
        const isVisible = (el) => {
          if (!el) return false;

          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);

          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            style.opacity !== '0'
          );
        };

        // TikTok comment button
        const commentButton = document.querySelector(
          '[data-e2e="comment-icon"]'
        );

        if (!commentButton) {
          return {
            targetFound: false,
            clicked: false,
            reason: 'comment-icon-not-found'
          };
        }

        // Đảm bảo icon đang hiển thị
        if (!isVisible(commentButton)) {
          return {
            targetFound: true,
            clicked: false,
            reason: 'comment-icon-not-visible'
          };
        }

        // Đảm bảo đây thực sự là button
        const role = commentButton.getAttribute('role');
        const tag = commentButton.tagName?.toLowerCase();

        if (tag !== 'button' && role !== 'button') {
          return {
            targetFound: true,
            clicked: false,
            reason: 'comment-icon-not-clickable'
          };
        }

        // Đưa icon vào vùng nhìn thấy
        commentButton.scrollIntoView({
          block: 'center',
          inline: 'center'
        });

        // Lấy lại vị trí sau khi scroll nếu cần debug
        const rect = commentButton.getBoundingClientRect();

        // Click trực tiếp vào DOM element
        commentButton.click();

        return {
          targetFound: true,
          clicked: true,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          reason: 'clicked'
        };

      } catch (e) {
        return {
          targetFound: false,
          clicked: false,
          reason: 'error',
          error: String(e)
        };
      }
    })();
  `).catch(() => ({
    targetFound: false,
    clicked: false,
    reason: 'js-eval-failed'
  }));
}

export interface VideoLikeState {
  found: boolean;
  liked: boolean;
  error?: string;
}

/**
 * Reads the current like/heart state of the video.
 */
export async function readVideoLikeState(win: BrowserWindow): Promise<VideoLikeState> {
  if (win.isDestroyed()) return { found: false, liked: false };

  return win.webContents.executeJavaScript(`
    (() => {
      try {
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const isRedOrPink = (str) => {
          if (!str) return false;
          const m = str.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/i);
          if (m) {
            const r = parseInt(m[1], 10);
            const g = parseInt(m[2], 10);
            const b = parseInt(m[3], 10);
            if (r >= 200 && g <= 100 && b <= 120) return true;
          }
          const s = str.toLowerCase().replace(/\\s+/g, '');
          return s.includes('#fe2c55') || s.includes('#ff3b5c') || s.includes('#ff2a5b') || s.includes('red') || s.includes('rgb(254,44,85)') || s.includes('rgb(255,59,92)');
        };
        const hasLikedColor = (el) => {
          if (!el) return false;
          const colorTargets = [
            el,
            ...Array.from(el.querySelectorAll('svg, path, [fill], [stroke], span, div'))
          ].filter(Boolean);
          return colorTargets.some(target => {
            const style = window.getComputedStyle(target);
            return isRedOrPink(style.color) ||
                   isRedOrPink(style.fill) ||
                   isRedOrPink(style.stroke) ||
                   isRedOrPink(target.getAttribute?.('fill')) ||
                   isRedOrPink(target.getAttribute?.('stroke'));
          });
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
          '[class*="LikeContainer" i]',
          '[class*="ButtonLike" i]'
        ];
        const node = selectors
          .flatMap(selector => Array.from(document.querySelectorAll(selector)))
          .find(isVisible);
        if (!node) return { found: false, liked: false };
        const btn = node.closest('button') || node.closest('[role="button"]') || node;
        const label = [
          btn.getAttribute?.('aria-label'),
          btn.getAttribute?.('title'),
          typeof btn.className === 'string' ? btn.className : '',
          btn.getAttribute?.('data-e2e'),
          node.getAttribute?.('aria-label'),
          node.getAttribute?.('title'),
          typeof node.className === 'string' ? node.className : '',
          node.getAttribute?.('data-e2e')
        ].filter(Boolean).join(' ').toLowerCase();

        const isLiked = btn.getAttribute?.('aria-pressed') === 'true' ||
                       btn.getAttribute?.('aria-checked') === 'true' ||
                       btn.getAttribute?.('data-active') === 'true' ||
                       label.includes('liked') ||
                       label.includes('unlike') ||
                       label.includes('đã thích') ||
                       label.includes('bỏ thích') ||
                       hasLikedColor(btn);

        return {
          found: true,
          liked: isLiked
        };
      } catch(e) {
        return { found: false, liked: false, error: e.toString() };
      }
    })();
  `).catch((err) => ({ found: false, liked: false, error: String(err) }));
}

/**
 * Clicks the video like button or double clicks the video player.
 */
export async function clickVideoLike(win: BrowserWindow): Promise<{ clicked: boolean; target?: string; error?: string }> {
  if (win.isDestroyed()) return { clicked: false };

  return win.webContents.executeJavaScript(`
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
          '[class*="LikeContainer" i]',
          '[class*="ButtonLike" i]'
        ];
        for (const s of selectors) {
          const el = Array.from(document.querySelectorAll(s)).find(isVisible);
          if (el) {
            const btn = el.closest('button') || el.closest('[role="button"]') || el;
            btn.click();
            return { clicked: true, target: 'like-button' };
          }
        }
        const video = document.querySelector('video');
        if (video && isVisible(video)) {
          video.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
          return { clicked: true, target: 'video-dblclick' };
        }
        return { clicked: false };
      } catch(e) { return { clicked: false, error: e.toString() }; }
    })()
  `).catch((err) => ({ clicked: false, error: String(err) }));
}

/**
 * Performs video like action with pre-check and confirmation.
 */
export async function performVideoLike(
  win: BrowserWindow,
  acc: AccountInfo,
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void
): Promise<boolean> {
  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'info',
    message: 'Đang thực hiện thả tim (Like) video...',
  });

  const initialState = await readVideoLikeState(win);
  if (initialState?.liked) {
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'info',
      message: '❤️ Video đã được thả tim sẵn, bỏ qua bấm lại.',
    });
    return true;
  }

  await clickVideoLike(win);
  await waitForSeedingDelay(1200, win);

  const stateAfter = await readVideoLikeState(win);
  if (stateAfter?.liked) {
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'success',
      message: '❤️ Đã xác nhận video được thả tim thành công.',
    });
    return true;
  } else {
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'info',
      message: '❤️ Đã gửi thao tác thả tim video.',
    });
    return false;
  }
}

export interface CommentDrawerStatus {
  isOpen: boolean;
  hasCommentTab: boolean;
  isCommentTabActive: boolean;
  hasCommentInput: boolean;
  isCommentInputVisible: boolean;
  reason: string;
}

/**
 * Checks if the TikTok video comment drawer is open.
 */
export async function checkVideoCommentDrawerStatus(win: BrowserWindow): Promise<CommentDrawerStatus> {
  if (win.isDestroyed()) {
    return {
      isOpen: false,
      hasCommentTab: false,
      isCommentTabActive: false,
      hasCommentInput: false,
      isCommentInputVisible: false,
      reason: 'window-destroyed',
    };
  }

  return await win.webContents.executeJavaScript(`
    (() => {
      try {
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            style.opacity !== '0'
          );
        };

        const commentInput = 
          document.querySelector('[data-e2e="comment-input"]') ||
          document.querySelector('div[contenteditable="true"][data-placeholder*="comment" i]') ||
          document.querySelector('div[contenteditable="true"][data-placeholder*="bình luận" i]') ||
          document.querySelector('[data-e2e="comment-text-area"]');

        const hasCommentInput = !!commentInput;
        const isCommentInputVisible = hasCommentInput && isVisible(commentInput);

        const tabButtons = [...document.querySelectorAll(
          'button[data-testid="tux-web-tab-bar"], [role="tab"]'
        )];

        const commentTab = tabButtons.find(button => {
          const text = (
            button.querySelector('[data-testid="tux-web-text"]')?.textContent ||
            button.textContent ||
            ''
          ).trim().toLowerCase();

          return text === 'bình luận' || text === 'comments' || text === 'comment';
        });

        const hasCommentTab = !!commentTab;
        let isCommentTabActive = false;

        if (commentTab) {
          const isAriaSelected = commentTab.getAttribute('aria-selected') === 'true';
          const tabContainer = commentTab.closest('[data-testid="tux-web-tab-bar-container"]');
          const computedStyle = window.getComputedStyle(tabContainer || commentTab);
          const styleColor = (tabContainer?.style.color || '') + computedStyle.color;

          isCommentTabActive = 
            isAriaSelected || 
            styleColor.includes('var(--tux-v2-color-ui-text-1)') ||
            commentTab.classList.contains('active');
        } else {
          isCommentTabActive = true;
        }

        const isOpen = isCommentInputVisible || (hasCommentTab && isCommentTabActive && isCommentInputVisible);

        let reason = 'closed';
        if (isOpen) {
          reason = 'comment-ready';
        } else if (hasCommentTab && !isCommentTabActive) {
          reason = 'comment-tab-not-active';
        } else if (hasCommentInput && !isCommentInputVisible) {
          reason = 'comment-input-not-visible';
        } else if (!hasCommentInput) {
          reason = 'comment-input-not-found';
        }

        return {
          isOpen,
          hasCommentTab,
          isCommentTabActive,
          hasCommentInput,
          isCommentInputVisible,
          reason
        };

      } catch (e) {
        return {
          isOpen: false,
          hasCommentTab: false,
          isCommentTabActive: false,
          hasCommentInput: false,
          isCommentInputVisible: false,
          reason: 'error: ' + String(e)
        };
      }
    })();
  `).catch((err) => ({
    isOpen: false,
    hasCommentTab: false,
    isCommentTabActive: false,
    hasCommentInput: false,
    isCommentInputVisible: false,
    reason: 'js-eval-failed: ' + String(err)
  }));
}

/**
 * Ensures the TikTok video comment drawer is open.
 * If the comment input, comment list, or right sidebar is already present, DOES NOT click anything.
 * If not present, clicks the floating comment icon on the video player ONCE.
 */
export async function ensureVideoCommentDrawerOpen(
  win: BrowserWindow,
  acc: AccountInfo,
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void
): Promise<boolean> {
  let initialStatus = await checkVideoCommentDrawerStatus(win);
  if (!initialStatus.isOpen) {
    const pollDeadline = Date.now() + 10000;
    while (Date.now() < pollDeadline) {
      await waitForSeedingDelay(1000, win);
      initialStatus = await checkVideoCommentDrawerStatus(win);
      if (initialStatus.isOpen) break;
    }
  }

  // If already open, DO NOT CLICK ANY TOGGLE BUTTON!
  if (initialStatus.isOpen) {
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'info',
      message: `[CommentDrawer] Khung bình luận đã có sẵn (${initialStatus.reason}), bỏ qua không bấm icon mở.`,
    });
    return true;
  }

  // 2. Not open: Click floating comment icon on video ONCE
  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'info',
    message: `[CommentDrawer] Khung bình luận chưa có, đang bấm vào biểu tượng bình luận`,
  });

  // Click first time
  await feedCommentClickTarget(win);

  // Wait max 3500ms for drawer to open
  const openDeadline = Date.now() + 3500;
  let afterClickStatus = await checkVideoCommentDrawerStatus(win);
  while (Date.now() < openDeadline && !afterClickStatus.isOpen) {
    await waitForSeedingDelay(300, win);
    afterClickStatus = await checkVideoCommentDrawerStatus(win);
  }

  // If not open after 3500ms -> Retry click and wait 5s
  if (!afterClickStatus.isOpen) {
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'warning',
      message: `[CommentDrawer] Sau 3.5s chưa mở được, đang bấm lại icon bình luận và chờ 5s...`,
    });

    await feedCommentClickTarget(win);

    const retryDeadline = Date.now() + 5000;
    while (Date.now() < retryDeadline && !afterClickStatus.isOpen) {
      await waitForSeedingDelay(500, win);
      afterClickStatus = await checkVideoCommentDrawerStatus(win);
    }
  }

  // Conclude final status
  if (afterClickStatus.isOpen) {
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'info',
      message: `[CommentDrawer] Khung bình luận đã mở thành công (${afterClickStatus.reason}).`,
    });
    return true;
  }

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'error',
    message: `[CommentDrawer] Không thể mở khung bình luận sau khi đã thử lại (${afterClickStatus.reason}).`,
  });
  return false;
}


export interface FocusCommentInputResult {
  success: boolean;
  focusX?: number;
  focusY?: number;
  editableTag?: string;
  editableRole?: string;
  editableE2e?: string;
  reason?: string;
  error?: string;
}

/**
 * Finds and focuses the video comment input element, returning coordinates.
 */
export async function focusVideoCommentInput(win: BrowserWindow): Promise<FocusCommentInputResult> {
  if (win.isDestroyed()) return { success: false, reason: 'window-destroyed' };

  return win.webContents.executeJavaScript(`
    (async () => {
      try {
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
        };

        const isCommentInput = (inp) => {
          if (!isVisible(inp)) return false;
          const ph = (inp.getAttribute('placeholder') || inp.getAttribute('data-placeholder') || inp.getAttribute('aria-label') || '').toLowerCase();
          if (ph.includes('search') || ph.includes('tìm kiếm') || ph.includes('email') || ph.includes('phone') || ph.includes('mật khẩu') || ph.includes('password')) return false;
          return true;
        };

        const inputSelectors = [
          '[data-e2e="comment-input"]',
          '[data-e2e="comment-input-area"]',
          'div[contenteditable="true"]',
          'div[contenteditable="plaintext-only"]',
          'div[contenteditable]',
          '[role="textbox"]',
          'div[class*="BottomCommentContainer" i]',
          'div[class*="DivCommentInput" i]',
          'div[class*="InputArea" i]',
          'div[class*="CommentInput" i]',
          'div[class*="comment-input" i]',
          'textarea'
        ];

        const findCommentInput = () => {
          for (const sel of inputSelectors) {
            const matches = Array.from(document.querySelectorAll(sel)).filter(isCommentInput);
            if (matches.length > 0) {
              return matches[matches.length - 1];
            }
          }

          const fallbackBox = Array.from(document.querySelectorAll('div, p, span, textarea, input')).filter(el => {
            if (!isVisible(el)) return false;
            const ph = (el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('aria-label') || '').toLowerCase();
            return (ph.includes('comment') || ph.includes('bình luận') || ph.includes('add comment') || ph.includes('thêm bình luận')) &&
                   !ph.includes('search') && !ph.includes('tìm kiếm');
          });
          return fallbackBox[0] || null;
        };

        let target = findCommentInput();

        // Scroll right sidebar to bottom to reveal comment box
        const commentContainers = document.querySelectorAll(
          '[data-e2e="video-detail-container"], div[class*="CommentContainer" i], div[class*="DivCommentListContainer" i], div[class*="DivRightContainer" i]'
        );
        commentContainers.forEach(c => {
          try { c.scrollTop = c.scrollHeight; } catch(e) {}
        });

        target = target || findCommentInput();
        const inputDeadline = Date.now() + 8000;
        while (!target && Date.now() < inputDeadline) {
          await new Promise(r => setTimeout(r, 500));
          target = findCommentInput();
        }

        if (!target) {
          return { success: false, reason: 'Không tìm thấy ô nhập bình luận' };
        }

        target.scrollIntoView({ behavior: 'instant', block: 'center' });
        await new Promise(r => setTimeout(r, 150));

        target.click();
        target.focus();
        await new Promise(r => setTimeout(r, 200));

        const editable = target.getAttribute('contenteditable') ? target :
          (target.querySelector('[contenteditable], [role="textbox"], textarea, input') || target);

        editable.focus();
        editable.click();

        try {
          const selection = window.getSelection();
          selection?.removeAllRanges();
        } catch(e) {}

        const rect = editable.getBoundingClientRect();
        return {
          success: true,
          focusX: Math.round(rect.left + Math.min(Math.max(rect.width / 2, 12), Math.max(rect.width - 12, 12))),
          focusY: Math.round(rect.top + Math.min(Math.max(rect.height / 2, 12), Math.max(rect.height - 12, 12))),
          editableTag: editable.tagName,
          editableRole: editable.getAttribute('role') || '',
          editableE2e: editable.getAttribute('data-e2e') || ''
        };
      } catch(e) {
        return { success: false, error: e.toString() };
      }
    })();
  `).catch((err) => ({ success: false, error: String(err) }));
}

export interface CommentSubmitResult {
  success: boolean;
  submitted?: boolean;
  method?: string;
  reason?: string;
  error?: string;
}

/**
 * Types comment text into the focused input and clicks the Post button or sends Enter.
 */
export async function typeAndSubmitVideoComment(
  win: BrowserWindow,
  commentText: string
): Promise<CommentSubmitResult> {
  if (win.isDestroyed()) return { success: false, reason: 'window-destroyed' };

  // 1. Dispatch input events to ensure DOM sync
  await win.webContents.executeJavaScript(`
    (() => {
      try {
        const expectedText = ${JSON.stringify(commentText)};
        const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const selectors = [
          '[data-e2e="comment-input"] [contenteditable]',
          '[data-e2e="comment-input"] [role="textbox"]',
          '[data-e2e="comment-input-area"] [contenteditable]',
          'div[contenteditable="true"]',
          'div[contenteditable="plaintext-only"]',
          '[role="textbox"]',
          'textarea'
        ];
        const inputs = selectors
          .flatMap(sel => Array.from(document.querySelectorAll(sel)))
          .filter(isVisible);
        const target = inputs[inputs.length - 1];
        if (!target) return { success: false, reason: 'no-visible-editable' };
        const current = normalize(target.value || target.innerText || target.textContent);
        if (current.includes(expectedText)) return { success: true, method: 'already-present' };

        target.focus();
        target.click();
        if ('value' in target) {
          target.value = expectedText;
        } else {
          target.textContent = expectedText;
        }

        let after = normalize(target.value || target.innerText || target.textContent);
        if (!after.includes(expectedText)) {
          if ('value' in target) {
            target.value = expectedText;
          } else {
            target.textContent = expectedText;
          }
        }

        try {
          window.getSelection()?.removeAllRanges();
        } catch(e) {}

        for (const eventName of ['beforeinput', 'input', 'change', 'keyup']) {
          try {
            if (eventName === 'beforeinput' || eventName === 'input') {
              target.dispatchEvent(new InputEvent(eventName, {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: expectedText
              }));
            } else {
              target.dispatchEvent(new Event(eventName, { bubbles: true, cancelable: true }));
            }
          } catch(e) {
            target.dispatchEvent(new Event(eventName, { bubbles: true, cancelable: true }));
          }
        }

        after = normalize(target.value || target.innerText || target.textContent);
        return { success: after.includes(expectedText), method: 'dom-inputevent' };
      } catch(e) {
        return { success: false, error: e.toString() };
      }
    })();
  `).catch(() => null);

  // 2. Click Post button or dispatch Enter event
  return await win.webContents.executeJavaScript(`
    (async () => {
      try {
        const expectedText = ${JSON.stringify(commentText)};
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };

        const active = document.activeElement;
        const activeText = (active?.value || active?.innerText || active?.textContent || '').trim();

        if (!activeText.includes(expectedText)) {
          const textInputs = Array.from(document.querySelectorAll(
            '[data-e2e="comment-input"], [data-e2e="comment-input-area"], div[contenteditable], [role="textbox"], textarea, input'
          )).filter(isVisible);
          const hasTypedText = textInputs.some(el => {
            const text = (el.value || el.innerText || el.textContent || '').trim();
            return text.includes(expectedText);
          });
          if (!hasTypedText) {
            return { success: false, reason: 'Đã focus ô bình luận nhưng TikTok không nhận ký tự nhập vào' };
          }
        }

        // Click Post button
        const postBtns = [
          '[data-e2e="comment-post"]',
          'div[data-e2e="comment-post"]',
          'button[data-e2e="comment-post"]',
          '[aria-label*="Post" i]',
          '[aria-label*="Đăng" i]',
          '[aria-label*="Send" i]',
          '[aria-label*="Gửi" i]',
          '[class*="DivPostButton"]',
          '[class*="PostBtn"]',
          '[class*="ButtonPost"]',
          '[class*="ButtonSend"]'
        ];

        let posted = false;
        for (const sel of postBtns) {
          const btn = document.querySelector(sel);
          if (btn && isVisible(btn) && btn.getAttribute('aria-disabled') !== 'true' && !btn.disabled) {
            btn.click();
            posted = true;
            break;
          }
        }

        if (!posted) {
          const editable = document.activeElement;
          editable?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          editable?.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          editable?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        }

        return { success: true, submitted: true, method: posted ? 'post-button' : 'enter-key' };
      } catch(e) {
        return { success: false, error: e.toString() };
      }
    })();
  `).catch((err) => ({ success: false, error: String(err) }));
}

export interface CommentVerifyResult {
  success: boolean;
  verified: boolean;
  method?: string;
  reason?: string;
  error?: string;
  x?: number;
  y?: number;
}

/**
 * Polls the comments pane on the TikTok video to verify if the comment is visibly rendered.
 */
export async function verifyVideoCommentPosted(
  win: BrowserWindow,
  commentText: string
): Promise<CommentVerifyResult> {
  if (win.isDestroyed()) return { success: false, verified: false, reason: 'window-destroyed' };

  return win.webContents.executeJavaScript(`
    (async () => {
      try {
        const expectedText = ${JSON.stringify(commentText)};
        const normalize = (text) => (text || '').replace(/\\s+/g, ' ').trim();
        const expected = normalize(expectedText);
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const isInputLike = (el) => !!el?.closest?.(
          '[data-e2e="comment-input"], [data-e2e="comment-input-area"], [data-e2e="comment-post"], div[contenteditable], [role="textbox"], textarea, input'
        );
        const getCommentPane = () => {
          const selectors = [
            '[data-e2e="video-detail-container"]',
            'div[class*="DivCommentContainer"]',
            'div[class*="CommentContainer"]',
            'div[class*="CommentListContainer"]',
            'div[class*="DivRightContainer"]'
          ];
          return selectors
            .flatMap(sel => Array.from(document.querySelectorAll(sel)))
            .filter(isVisible)
            .map(el => ({ el, rect: el.getBoundingClientRect() }))
            .filter(({ rect }) => rect.width >= 180 && rect.left > window.innerWidth * 0.35)
            .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0]?.el || document;
        };
        const commentSelectors = [
          '[data-e2e*="comment-level"]',
          '[data-e2e*="comment-item"]',
          '[data-e2e*="comment-text"]',
          '[class*="CommentItem"]',
          '[class*="CommentText"]',
          '[class*="DivCommentContent"]',
          '[class*="DivCommentItem"]',
          'p',
          'span'
        ];

        const deadline = Date.now() + 8500;
        while (Date.now() < deadline) {
          const pane = getCommentPane();
          const candidates = commentSelectors
            .flatMap(sel => Array.from(pane.querySelectorAll(sel)))
            .filter(el => isVisible(el) && !isInputLike(el));

          const found = candidates.find(el => normalize(el.innerText || el.textContent).includes(expected));
          if (found) {
            const rect = found.getBoundingClientRect();
            return {
              success: true,
              verified: true,
              method: 'visible-comment',
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2)
            };
          }
          await new Promise(r => setTimeout(r, 600));
        }

        return {
          success: true,
          verified: false,
          reason: 'Bình luận đã gửi nhưng chưa xuất hiện trong danh sách hiển thị (có thể cần duyệt hoặc tải chậm)'
        };
      } catch(e) {
        return { success: true, verified: false, error: e.toString() };
      }
    })();
  `).catch((err) => ({ success: true, verified: false, error: String(err) }));
}

/**
 * Handles the complete process of posting a comment on a TikTok video:
 * 1. Open drawer
 * 2. Solve captcha if prompted
 * 3. Check for existing comment
 * 4. Focus input, type comment, click post / send Enter
 * 5. Solve post-submit captcha if prompted
 * 6. Verify comment visibility in comments list
 */
export async function performVideoComment(
  win: BrowserWindow,
  acc: AccountInfo,
  comments: string[],
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void
): Promise<void> {
  const commentText = comments[Math.floor(Math.random() * comments.length)].trim();
  if (!commentText) return;

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'info',
    message: `Đang chuẩn bị gửi bình luận: "${commentText}"...`,
  });

  await waitForSeedingDelay(1000, win);

  // Step 1: Ensure comment drawer is open (clicks at most once if not already open)
  await ensureVideoCommentDrawerOpen(win, acc, onLog);
  throwIfSeedingCancelled(win);

  // Step 1.5: Check for Captcha if opening drawer triggered one
  const hadCaptcha = await checkAndSolveAnyCaptcha(win, acc, onLog);
  throwIfSeedingCancelled(win);

  if (hadCaptcha) {
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'info',
      message: 'Đã giải CAPTCHA xong, đang đợi khung bình luận ổn định...',
    });
    await waitForSeedingDelay(1500, win);
  }


  // Step 3: Focus input, type comment, and post
  await ensureVideoCommentDrawerOpen(win, acc, onLog);

  const focusCommentResult = await focusVideoCommentInput(win);

  let commentResult: {
    success?: boolean;
    method?: string;
    reason?: string;
    error?: string;
    submitted?: boolean;
    verified?: boolean;
  } = focusCommentResult;

  if (focusCommentResult?.success) {
    if (typeof focusCommentResult.focusX === 'number' && typeof focusCommentResult.focusY === 'number') {
      win.focus();
      win.webContents.focus();
      await performZoomAwareElectronClick(win, focusCommentResult.focusX, focusCommentResult.focusY).catch(() => { });
      await waitForSeedingDelay(250, win);
    }

    const insertedByCdp = await performCdpInsertText(win, commentText);
    if (!insertedByCdp) {
      commentResult = { success: false, reason: 'Không gửi được ký tự vào ô bình luận qua CDP/Electron' };
    }

    await waitForSeedingDelay(700, win);

    if (insertedByCdp) {
      commentResult = await typeAndSubmitVideoComment(win, commentText);
    }
  }

  if (commentResult?.success && commentResult?.submitted && commentResult?.method !== 'post-button') {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  }

  if (commentResult?.success && commentResult?.submitted) {
    // Solve immediate post-comment captcha
    await checkAndSolveAnyCaptcha(win, acc, onLog);
    throwIfSeedingCancelled(win);

    await waitForSeedingDelay(2500, win);

    const verifyResult = await verifyVideoCommentPosted(win, commentText);

    commentResult = {
      ...commentResult,
      success: !!verifyResult?.verified,
      verified: !!verifyResult?.verified,
      method: verifyResult?.method || commentResult.method,
      reason: verifyResult?.reason || commentResult.reason,
      error: verifyResult?.error || commentResult.error,
    };
  }

  // Solve any captcha that appeared during/after verification
  await checkAndSolveAnyCaptcha(win, acc, onLog);
  throwIfSeedingCancelled(win);

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: commentResult?.verified ? 'success' : 'warning',
    message: commentResult?.verified
      ? `💬 Đã xác minh bình luận hiển thị trên video: "${commentText}".`
      : `💬 Chưa xác minh được bình luận video cho @${acc.username}: ${commentResult?.reason || commentResult?.error || 'không rõ lỗi'}.`,
  });
}

/**
 * Orchestrates all video seeding actions (Like and Comment).
 */
export async function performVideoSeeding(
  win: BrowserWindow,
  acc: AccountInfo,
  config: SeedingTaskConfig,
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void
): Promise<void> {
  // Natural Watch Time: watch video for 5-9 seconds to register valid view count and avoid instantaneous bot flag
  const naturalWatchSeconds = 5 + Math.floor(Math.random() * 5);
  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'info',
    message: `⏳ [Watch] Đang ngâm xem video ${naturalWatchSeconds}s cho @${acc.username} để tăng trust trước khi tương tác...`,
  });

  const watchEnd = Date.now() + naturalWatchSeconds * 1000;
  while (Date.now() < watchEnd && !win.isDestroyed()) {
    throwIfSeedingCancelled(win);
    await waitForSeedingDelay(Math.min(1500, Math.max(200, watchEnd - Date.now())), win);
  }
  throwIfSeedingCancelled(win);

  if (config.likeEnabled) {
    await performVideoLike(win, acc, onLog);
    await waitForSeedingDelay(800 + Math.random() * 800, win);
  }

  await checkAndSolveAnyCaptcha(win, acc, onLog);
  throwIfSeedingCancelled(win);

  if (config.comments && config.comments.length > 0) {
    await performVideoComment(win, acc, config.comments, onLog);
  }
}
