import { BrowserWindow, session } from 'electron';
import { SeedingTaskConfig, TaskLogItem } from '../nest/automation/automation.interface';
import { AccountInfo, AccountStatus, SeedingStateChange } from './types';
import {
  AccountSessionUpdate,
  attachProxyAuthHandler,
  configureSessionProxyAndCookies,
  hasTikTokSessionCookie,
  isTikTokCookie,
  persistTikTokSessionCookies,
} from './session-profile';
import {
  getSeedingCancelReason,
  isSeedingCancelRequested,
  requestSeedingCancel,
  runSessionPreparation,
  throwIfSeedingCancelled,
  waitForSeedingDelay,
} from './seeding-control';
import {
  applyTikTokSeedingZoom,
  getTiledSeedingWindowBounds,
  keepTikTokSeedingZoom,
  TIKTOK_SEEDING_ZOOM,
  TILED_VIDEO_COMMENT_MIN_HEIGHT,
  TILED_VIDEO_COMMENT_MIN_WIDTH,
} from './window-layout';
import {
  loadTikTokUrlForSeeding,
  waitForTikTokSurfaceReady,
  TIKTOK_SURFACE_READY_TIMEOUT_MS,
} from './tiktok-page';
import {
  performZoomAwareElectronClick,
  performCdpInsertText,
} from './browser-control';
import { checkAndSolveAnyCaptcha, solveTikTokWebCaptchaWithOmo } from './captcha-solver';
import { tapLiveContinuously } from './tiktok-live-actions';
import { ensureAuthenticatedForSeeding } from './tiktok-login-flow';

export const seedingWindows = new Set<BrowserWindow>();

const SEEDING_POST_ACTION_STABILIZE_MS = 12000;
const LIVESTREAM_INITIAL_COMMENT_DELAY_MS = 15000;

/**
 * Execute automation actions for a single account on TikTok Video / Live
 */
export async function executeTaskForAccount(
  acc: AccountInfo & { proxy?: string; proxyType?: string },
  config: SeedingTaskConfig,
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void,
  onAccountStatusChange: (id: string, status: AccountStatus) => void,
  onAccountSessionUpdate: (id: string, update: AccountSessionUpdate) => void,
  windowSlot: number = 0,
  onSeedingStateChange?: (state: SeedingStateChange) => void
) {
  const partition = `persist:tiktok_${acc.id}`;
  const customSession = session.fromPartition(partition);
  customSession.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  const proxyConfig = await runSessionPreparation(() =>
    configureSessionProxyAndCookies(customSession, acc.cookie, acc.proxy, acc.proxyType, {
      skipCookieInjectionIfSessionExists: true,
    })
  );

  const cookies = await customSession.cookies.get({});
  const hasSession = hasTikTokSessionCookie(cookies) || cookies.some(c => isTikTokCookie(c) && c.name.includes('uid_tt'));

  if (!hasSession) {
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'warning',
      message: `⚠️ Tài khoản @${acc.username} CHƯA DỰNG SESSION ĐĂNG NHẬP! Bạn hãy gán Cookie hoặc đăng nhập thủ công.`,
    });
  }

  const needsVideoCommentLayout = config.targetType === 'video' && !!config.comments?.some(comment => comment.trim().length > 0);
  const win = new BrowserWindow({
    ...getTiledSeedingWindowBounds(windowSlot, needsVideoCommentLayout),
    show: true,
    title: `[Seeding Worker] @${acc.username} - ${config.targetType}`,
    autoHideMenuBar: true,
    webPreferences: {
      session: customSession,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  if (needsVideoCommentLayout) {
    win.setMinimumSize(TILED_VIDEO_COMMENT_MIN_WIDTH, TILED_VIDEO_COMMENT_MIN_HEIGHT);
  }
  seedingWindows.add(win);
  keepTikTokSeedingZoom(win);
  let closedByAutomation = false;
  win.on('closed', () => {
    seedingWindows.delete(win);
    if (!closedByAutomation) {
      requestSeedingCancel(`Nguoi dung da dong cua so seeding cua @${acc.username}.`);
    }
    if (seedingWindows.size === 0 && isSeedingCancelRequested()) {
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'warning',
        message: 'Tat ca cua so seeding da dong. Dang dung task hien tai...',
      });
      onSeedingStateChange?.({
        isRunning: false,
        canceled: true,
        reason: getSeedingCancelReason(),
      });
    }
  });
  const muteBrowserAudio = config.muteBrowserAudio !== false;
  win.webContents.setAudioMuted(muteBrowserAudio);
  attachProxyAuthHandler(win, proxyConfig?.auth);

  try {
    if (muteBrowserAudio) {
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'info',
        message: `[Audio] Muted browser audio for @${acc.username}.`,
      });
    }

    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'info',
      message: `Đang tải URL trang TikTok: ${config.targetUrl}...`,
    });

    await loadTikTokUrlForSeeding(win, customSession, config.targetUrl, acc, onLog);
    throwIfSeedingCancelled(win);
    win.webContents.setZoomFactor(TIKTOK_SEEDING_ZOOM);
    await win.webContents.executeJavaScript(`
      (() => {
        try {
          document.documentElement.style.overflowX = 'auto';
          document.body.style.overflowX = 'auto';
          document.scrollingElement && (document.scrollingElement.scrollLeft = 0);
          const horizontalScrollers = Array.from(document.querySelectorAll('*')).filter(el => el.scrollWidth > el.clientWidth + 80);
          horizontalScrollers.slice(0, 6).forEach(el => {
            try { el.scrollLeft = 0; } catch(e) {}
          });
        } catch(e) {}
      })();
    `);
    await waitForSeedingDelay(800, win);

    const authReady = await ensureAuthenticatedForSeeding(
      win,
      customSession,
      acc,
      config.targetUrl,
      onLog,
      onAccountStatusChange,
      onAccountSessionUpdate
    );
    if (!authReady) {
      throw new Error(`@${acc.username} is logged out and could not be re-authenticated.`);
    }
    throwIfSeedingCancelled(win);

    win.webContents.setZoomFactor(TIKTOK_SEEDING_ZOOM);
    await win.webContents.executeJavaScript(`
      (() => {
        try {
          document.documentElement.style.overflowX = 'auto';
          document.body.style.overflowX = 'auto';
          document.scrollingElement && (document.scrollingElement.scrollLeft = 0);
          const horizontalScrollers = Array.from(document.querySelectorAll('*')).filter(el => el.scrollWidth > el.clientWidth + 80);
          horizontalScrollers.slice(0, 6).forEach(el => {
            try { el.scrollLeft = 0; } catch(e) {}
          });
        } catch(e) {}
      })();
    `);
    await waitForSeedingDelay(800, win);

    const hasInitialCaptcha = await win.webContents.executeJavaScript(`
      (() => {
        const bodyText = document.body?.innerText || '';
        return !!document.querySelector('iframe[src*="captcha"], iframe[src*="sec"], #captcha-verify-container, .sec-captcha-container') ||
               bodyText.includes('Drag the slider') ||
               bodyText.includes('Complete the puzzle') ||
               bodyText.includes('Verify to continue');
      })();
    `).catch(() => false);
    if (hasInitialCaptcha) {
      await solveTikTokWebCaptchaWithOmo(win, acc, onLog).catch(err => {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'error',
          message: `[Captcha] Initial OmoCaptcha solve error: ${err?.message || err}`,
        });
        return false;
      });
      applyTikTokSeedingZoom(win);
    }
    throwIfSeedingCancelled(win);

    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'info',
      message: `Đang đợi TikTok render ổn định trước khi thao tác...`,
    });

    const surfaceReady = await waitForTikTokSurfaceReady(win, config.targetType);
    throwIfSeedingCancelled(win);
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: surfaceReady.ready ? 'info' : 'warning',
      message: surfaceReady.ready
        ? `TikTok đã sẵn sàng: video=${surfaceReady.hasVideo ? 'có' : 'không'}, like=${surfaceReady.hasVideoLike || surfaceReady.hasLiveLike ? 'có' : 'không'}, chat/comment=${surfaceReady.hasVideoComment || surfaceReady.hasLiveChat ? 'có' : 'không'}.`
        : `TikTok chưa ổn định sau ${Math.round(TIKTOK_SURFACE_READY_TIMEOUT_MS / 1000)}s (${surfaceReady.reason || 'không rõ'}). Trạng thái: readyState=${surfaceReady.readyState || 'unknown'}, video=${surfaceReady.hasVideo ? 'có' : 'không'}, like=${surfaceReady.hasVideoLike || surfaceReady.hasLiveLike ? 'có' : 'không'}, chat/comment=${surfaceReady.hasVideoComment || surfaceReady.hasLiveChat ? 'có' : 'không'}.`,
    });

    if (config.targetType === 'video') {
      if (config.likeEnabled) {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'info',
          message: 'Đang thực hiện thả tim (Like) video...',
        });

        const readVideoLikeState = async () => win.webContents.executeJavaScript(`
          (() => {
            try {
              const isVisible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
              };
              const isLikedColor = (color) => {
                if (!color) return false;
                const normalized = color.replace(/\\s+/g, '').toLowerCase();
                return normalized === 'rgb(255,59,92)' ||
                       normalized === 'rgba(255,59,92,1)' ||
                       normalized === 'rgb(254,44,85)' ||
                       normalized === 'rgba(254,44,85,1)' ||
                       normalized === 'rgb(255,42,91)' ||
                       normalized === 'rgba(255,42,91,1)' ||
                       normalized === 'rgb(235,32,73)' ||
                       normalized === 'rgba(235,32,73,1)' ||
                       normalized.includes('#fe2c55') ||
                       normalized.includes('#ff3b5c') ||
                       normalized.includes('#ff2a5b') ||
                       normalized === 'red';
              };
              const hasLikedColor = (el) => {
                if (!el) return false;
                const colorTargets = [
                  el,
                  el.querySelector?.('svg'),
                  el.querySelector?.('path'),
                  el.querySelector?.('[fill]'),
                  el.querySelector?.('[stroke]')
                ].filter(Boolean);
                return colorTargets.some(target => {
                  const style = window.getComputedStyle(target);
                  return isLikedColor(style.color) ||
                         isLikedColor(style.fill) ||
                         isLikedColor(style.stroke) ||
                         isLikedColor(target.getAttribute?.('fill')) ||
                         isLikedColor(target.getAttribute?.('stroke'));
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
                '[class*="LikeContainer"]',
                '[class*="ButtonLike"]'
              ];
              const node = selectors
                .flatMap(selector => Array.from(document.querySelectorAll(selector)))
                .find(isVisible);
              if (!node) return { found: false, liked: false };
              const label = [
                node.getAttribute?.('aria-label'),
                node.getAttribute?.('title'),
                node.getAttribute?.('class'),
                node.getAttribute?.('data-e2e')
              ].join(' ').toLowerCase();
              return {
                found: true,
                liked: node.getAttribute?.('aria-pressed') === 'true' ||
                       label.includes('liked') ||
                       label.includes('unlike') ||
                       label.includes('đã thích') ||
                       label.includes('bỏ thích') ||
                       hasLikedColor(node)
              };
            } catch(e) {
              return { found: false, liked: false, error: e.toString() };
            }
          })();
        `);

        // Check if already liked first
        const initialState = await readVideoLikeState();
        if (initialState?.liked) {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: '❤️ Video đã được thả tim sẵn, bỏ qua bấm lại.',
          });
        } else {
          let likedSuccess = false;
          for (let attempt = 1; attempt <= 2; attempt++) {
            await win.webContents.executeJavaScript(`
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
                      return { clicked: true, target: 'like-button' };
                    }
                  }
                  const video = document.querySelector('video');
                  if (video) {
                    video.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
                    return { clicked: true, target: 'video-dblclick' };
                  }
                  return { clicked: false };
                } catch(e) { return { clicked: false, error: e.toString() }; }
              })()
            `);

            await waitForSeedingDelay(1000, win);
            const stateAfter = await readVideoLikeState();
            if (stateAfter?.liked) {
              likedSuccess = true;
              break;
            }
          }

          if (likedSuccess) {
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'success',
              message: '❤️ Đã xác nhận video được thả tim thành công.',
            });
          } else {
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'info',
              message: '❤️ Đã gửi thao tác thả tim video.',
            });
          }
        }
      }

      await checkAndSolveAnyCaptcha(win, acc, onLog);
      throwIfSeedingCancelled(win);

      if (config.comments && config.comments.length > 0) {
        const commentText = config.comments[Math.floor(Math.random() * config.comments.length)].trim();
        if (commentText) {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: `Đang tự động gõ bình luận: "${commentText}"...`,
          });

          await waitForSeedingDelay(1200, win);

          const feedCommentClickTarget = await win.webContents.executeJavaScript(`
            (() => {
              try {
                const isVisible = (el) => {
                  if (!el) return false;
                  const rect = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };
                const hasCommentPane = Array.from(document.querySelectorAll(
                  '[data-e2e="video-detail-container"], div[class*="DivRightContainer"], div[class*="DivContentContainer"], div[class*="DivCommentContainer"], div[class*="CommentContainer"], div[class*="CommentListContainer"]'
                )).filter(isVisible).some(el => {
                  const rect = el.getBoundingClientRect();
                  return rect.width >= 180 && rect.left > window.innerWidth * 0.45;
                });
                if (hasCommentPane) return null;
                const isFeedLayout = Array.from(document.querySelectorAll(
                  '[data-e2e="feed-video"], [data-e2e="recommend-list-item-container"], [class*="DivFeedVideo"], [class*="FeedVideo"]'
                )).some(isVisible);
                if (!isFeedLayout) return null;
                const selectors = [
                  '[data-e2e="comment-icon"]',
                  '[data-e2e="browse-comment-icon"]',
                  '[data-e2e="feed-comment-icon"]',
                  '[data-e2e="video-comment-icon"]',
                  'button[aria-label*="comment" i]',
                  'button[aria-label*="bình luận" i]',
                  '[role="button"][aria-label*="comment" i]',
                  '[role="button"][aria-label*="bình luận" i]'
                ];
                const candidates = selectors
                  .flatMap(sel => Array.from(document.querySelectorAll(sel)))
                  .filter(isVisible)
                  .map(el => {
                    const clickable = el.closest('button') || el.closest('[role="button"]') || el;
                    const rect = clickable.getBoundingClientRect();
                    return { rect };
                  })
                  .filter(({ rect }) => rect.width <= 130 && rect.height <= 130 && rect.left > window.innerWidth * 0.45 && rect.top >= 0 && rect.top < window.innerHeight)
                  .sort((a, b) => a.rect.top - b.rect.top);
                const target = candidates[0];
                if (!target) return null;
                return {
                  x: Math.round(target.rect.left + target.rect.width / 2),
                  y: Math.round(target.rect.top + target.rect.height / 2)
                };
              } catch(e) {
                return null;
              }
            })();
          `);

          if (feedCommentClickTarget?.x && feedCommentClickTarget?.y) {
            await performZoomAwareElectronClick(win, feedCommentClickTarget.x, feedCommentClickTarget.y);
            await waitForSeedingDelay(1800, win);
          }

          const visibleCommentsTabTarget = await win.webContents.executeJavaScript(`
            (() => {
              try {
                const isVisible = (el) => {
                  if (!el) return false;
                  const rect = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };
                const candidates = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], div, span, p'))
                  .filter(isVisible)
                  .map(el => {
                    const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
                    const rect = el.getBoundingClientRect();
                    const clickable = el.closest('button') || el.closest('[role="tab"]') || el.closest('[role="button"]') || el;
                    const clickableRect = clickable.getBoundingClientRect();
                    return { text, rect, clickableRect };
                  })
                  .filter(({ text, rect }) => {
                    if (rect.width > 360 || rect.height > 110) return false;
                    if (rect.left < window.innerWidth * 0.4) return false;
                    return text === 'comments' ||
                      text === 'comment' ||
                      text === 'bình luận' ||
                      text === 'binh luan' ||
                      text.includes('comments') ||
                      text.includes('bình luận');
                  })
                  .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
                const target = candidates[0];
                if (!target) return null;
                return {
                  x: Math.round(target.clickableRect.left + target.clickableRect.width / 2),
                  y: Math.round(target.clickableRect.top + target.clickableRect.height / 2)
                };
              } catch(e) {
                return null;
              }
            })();
          `);

          if (visibleCommentsTabTarget?.x && visibleCommentsTabTarget?.y) {
            await performZoomAwareElectronClick(win, visibleCommentsTabTarget.x, visibleCommentsTabTarget.y);
            await waitForSeedingDelay(1400, win);
          }

          const focusCommentResult = await win.webContents.executeJavaScript(`
            (async () => {
              try {
                const isVisible = (el) => {
                  if (!el) return false;
                  const rect = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };

                const inputSelectors = [
                  '[data-e2e="comment-input"]',
                  'div[contenteditable="true"]',
                  'div[contenteditable="plaintext-only"]',
                  'div[contenteditable]',
                  '[role="textbox"]',
                  '[data-e2e="comment-input-area"]',
                  'div[class*="BottomCommentContainer"]',
                  'div[class*="DivCommentInput"]',
                  'div[class*="InputArea"]',
                  'div[class*="CommentInput"]',
                  'textarea'
                ];

                const findCommentInput = () => {
                  for (const sel of inputSelectors) {
                    const matches = Array.from(document.querySelectorAll(sel)).filter(isVisible);
                    if (matches.length > 0) {
                      return matches[matches.length - 1];
                    }
                  }

                  const fallbackBox = Array.from(document.querySelectorAll('div, p, span, textarea, input')).filter(el => {
                    if (!isVisible(el)) return false;
                    const ph = (el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('aria-label') || '').toLowerCase();
                    return ph.includes('comment') || ph.includes('bình luận') || ph.includes('add comment') || ph.includes('thêm bình luận');
                  });
                  return fallbackBox[0] || null;
                };

                const getCommentPane = () => {
                  const selectors = [
                    '[data-e2e="video-detail-container"]',
                    'div[class*="DivRightContainer"]',
                    'div[class*="DivContentContainer"]',
                    'div[class*="DivCommentContainer"]',
                    'div[class*="CommentContainer"]',
                    'div[class*="CommentListContainer"]'
                  ];

                  return selectors
                    .flatMap(sel => Array.from(document.querySelectorAll(sel)))
                    .filter(isVisible)
                    .map(el => ({ el, rect: el.getBoundingClientRect() }))
                    .filter(({ rect }) => rect.width >= 180 && rect.left > window.innerWidth * 0.45)
                    .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0]?.el || null;
                };

                const clickCommentsTab = (allowDocumentFallback = false) => {
                  const pane = getCommentPane();
                  if (!pane && !allowDocumentFallback) return false;
                  const scope = pane || document;
                  const candidates = Array.from(scope.querySelectorAll('button, [role="tab"], [role="button"], div, span, p'))
                    .filter(isVisible)
                    .filter(el => {
                      const rect = el.getBoundingClientRect();
                      if (rect.width > 320 || rect.height > 90) return false;
                      if (!pane && rect.left < window.innerWidth * 0.45) return false;
                      const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
                      return text === 'comments' ||
                             text === 'comment' ||
                             text === 'bình luận' ||
                             text === 'binh luan' ||
                             text.includes('comments') ||
                             text.includes('bình luận');
                    });

                  const tab = candidates
                    .map(el => el.closest('button') || el.closest('[role="tab"]') || el.closest('[role="button"]') || el)
                    .find(isVisible);

                  if (!tab) return false;
                  tab.click();
                  return true;
                };

                const openFeedCommentDrawer = async () => {
                  const isFeedLayout = Array.from(document.querySelectorAll(
                    '[data-e2e="feed-video"], [data-e2e="recommend-list-item-container"], [class*="DivFeedVideo"], [class*="FeedVideo"]'
                  )).some(isVisible);
                  if (!isFeedLayout || getCommentPane()) return false;
                  const getClickableParent = (el) => {
                    let cur = el;
                    for (let i = 0; i < 8 && cur; i++) {
                      const tag = cur.tagName?.toLowerCase();
                      const role = cur.getAttribute?.('role');
                      const style = window.getComputedStyle(cur);
                      if (tag === 'button' || role === 'button' || typeof cur.onclick === 'function' || style.cursor === 'pointer') return cur;
                      cur = cur.parentElement;
                    }
                    return el;
                  };

                  const iconSelectors = [
                    '[data-e2e="comment-icon"]',
                    '[data-e2e="browse-comment-icon"]',
                    '[data-e2e="feed-comment-icon"]',
                    '[data-e2e="video-comment-icon"]',
                    'button[aria-label*="comment" i]',
                    'button[aria-label*="bình luận" i]',
                    '[role="button"][aria-label*="comment" i]',
                    '[role="button"][aria-label*="bình luận" i]',
                    'strong[data-e2e*="comment-count"]'
                  ];

                  const candidates = iconSelectors
                    .flatMap(sel => Array.from(document.querySelectorAll(sel)))
                    .filter(isVisible)
                    .map(getClickableParent)
                    .filter(Boolean)
                    .filter((el, index, arr) => arr.indexOf(el) === index)
                    .map(el => ({ el, rect: el.getBoundingClientRect() }))
                    .filter(({ rect }) => rect.width <= 130 && rect.height <= 130 && rect.left > window.innerWidth * 0.45)
                    .sort((a, b) => b.rect.left - a.rect.left);

                  if (candidates.length === 0) return false;
                  candidates[0].el.click();
                  await new Promise(r => setTimeout(r, 1200));
                  clickCommentsTab(true);
                  await new Promise(r => setTimeout(r, 700));
                  return true;
                };

                let target = findCommentInput();

                if (!target) {
                  const hadPane = !!getCommentPane();
                  const tabClicked = hadPane ? clickCommentsTab() : false;
                  if (tabClicked) await new Promise(r => setTimeout(r, 700));
                  target = findCommentInput();
                  if (!target && !hadPane) {
                    const openedFeedDrawer = await openFeedCommentDrawer();
                    target = openedFeedDrawer ? findCommentInput() : null;
                    if (!target) {
                      return {
                        success: false,
                        reason: openedFeedDrawer
                          ? 'Đã mở comment ở feed layout nhưng không thấy ô nhập bình luận'
                          : 'Không thấy panel comment bên phải và cũng không xác định được feed comment drawer an toàn'
                      };
                    }
                  }
                }

                // Scroll right sidebar to bottom to reveal comment box after selecting the comment tab.
                const commentContainers = document.querySelectorAll(
                  '[data-e2e="video-detail-container"], div[class*="CommentContainer"], div[class*="DivCommentListContainer"], div[class*="DivRightContainer"], div[class*="DivContentContainer"]'
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

                // Find the editable node inside
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
          `);

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
              await performZoomAwareElectronClick(win, focusCommentResult.focusX, focusCommentResult.focusY).catch(() => {});
              await waitForSeedingDelay(250, win);
            }

            const insertedByCdp = await performCdpInsertText(win, commentText);
            if (!insertedByCdp) {
              commentResult = { success: false, reason: 'Không gửi được ký tự vào ô bình luận qua CDP/Electron' };
            }

            await waitForSeedingDelay(700, win);

            if (insertedByCdp) {
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

              commentResult = await win.webContents.executeJavaScript(`
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
                  editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                  editable.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                  editable.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                }

                return { success: true, submitted: true, method: posted ? 'post-button' : 'enter-key' };
              } catch(e) {
                return { success: false, error: e.toString() };
              }
            })();
          `);
            }
          }

          if (commentResult?.success && commentResult?.submitted && commentResult?.method !== 'post-button') {
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
          }

          if (commentResult?.success && commentResult?.submitted) {
            await waitForSeedingDelay(2500, win);

            const verifyResult = await win.webContents.executeJavaScript(`
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
                      'div[class*="DivRightContainer"]',
                      'div[class*="DivContentContainer"]',
                      'div[class*="DivCommentContainer"]',
                      'div[class*="CommentContainer"]',
                      'div[class*="CommentListContainer"]'
                    ];
                    return selectors
                      .flatMap(sel => Array.from(document.querySelectorAll(sel)))
                      .filter(isVisible)
                      .map(el => ({ el, rect: el.getBoundingClientRect() }))
                      .filter(({ rect }) => rect.width >= 180 && rect.left > window.innerWidth * 0.45)
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
                    await new Promise(r => setTimeout(r, 500));
                  }

                  return {
                    success: false,
                    verified: false,
                    reason: 'Đã gửi thao tác bình luận nhưng chưa thấy nội dung xuất hiện trong danh sách comment'
                  };
                } catch(e) {
                  return { success: false, verified: false, error: e.toString() };
                }
              })();
            `);

            commentResult = {
              ...commentResult,
              success: !!verifyResult?.verified,
              verified: !!verifyResult?.verified,
              method: verifyResult?.method || commentResult.method,
              reason: verifyResult?.reason || commentResult.reason,
              error: verifyResult?.error || commentResult.error,
            };
          }

          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: commentResult?.verified ? 'success' : 'warning',
            message: commentResult?.verified
              ? `💬 Đã xác minh bình luận hiển thị trên video: "${commentText}".`
              : `💬 Chưa xác minh được bình luận video cho @${acc.username}: ${commentResult?.reason || commentResult?.error || 'không rõ lỗi'}.`,
          });
        }
      }
    } else if (config.targetType === 'livestream') {
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
          `);

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
            `);

            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: liveSendResult?.clicked ? 'info' : 'warning',
              message: liveSendResult?.clicked
                ? `💬 Đã click nút gửi bình luận Live: "${liveCommentText}". TikTok chưa xác nhận bình luận đã hiển thị.`
                : `Không click được nút gửi Live cho @${acc.username}. Nút gửi: ${liveSendResult?.sendBtnVisible ? 'có hiện' : 'không hiện'}, trạng thái: ${liveSendResult?.isProbablyDisabled ? 'chưa sẵn sàng' : 'không rõ'}, text trong ô: ${liveSendResult?.inputTextLength ?? 0} ký tự.`,
            });
          } else {
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'warning',
              message: `Không gửi được bình luận Live cho @${acc.username}: ${focusLiveComment?.reason || 'không tìm thấy ô bình luận'}`,
            });
          }
        }
      }

      if (config.likeEnabled) {
        await tapLiveContinuously(win, acc, liveDurationSeconds, onLog, 'main');
      } else {
        await waitForSeedingDelay(liveDurationSeconds * 1000, win);
      }
    }

    await waitForSeedingDelay(SEEDING_POST_ACTION_STABILIZE_MS, win);
    throwIfSeedingCancelled(win);
    // Final safety check: if Captcha is still on screen, keep window open and solve before closing
    let safetyRetries = 0;
    while (safetyRetries < 3) {
      if (win.isDestroyed() || isSeedingCancelRequested()) break;
      const hasActiveCaptcha = await win.webContents.executeJavaScript(`
        (() => {
          try {
            const isVisible = (el) => {
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 20 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none';
            };
            const selectors = [
              '#captcha-verify-container', '.captcha-verify-container',
              '#captcha_verify_container', '.captcha_verify_container',
              '.sec-captcha-container', '.captcha-container', '.verify-wrap',
              '[class*="captcha-card" i]', '[class*="captcha-modal" i]',
              '[class*="captcha_card" i]', '[class*="captcha_modal" i]',
              'iframe[src*="captcha"]', 'iframe[src*="sec"]', 'iframe[src*="verify"]'
            ];
            return selectors.some(s => Array.from(document.querySelectorAll(s)).some(isVisible));
          } catch(e) { return false; }
        })();
      `).catch(() => false);

      if (!hasActiveCaptcha) break;

      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'warning',
        message: `[Captcha] ⏳ Phát hiện CAPTCHA vẫn đang hiển thị, giữ cửa sổ để tiếp tục giải cho @${acc.username}...`,
      });
      await solveTikTokWebCaptchaWithOmo(win, acc, onLog);
      safetyRetries++;
      await waitForSeedingDelay(3000, win).catch(() => {});
    }
    throwIfSeedingCancelled(win);
    await persistTikTokSessionCookies(
      acc.id,
      acc.username,
      customSession,
      onLog,
      onAccountSessionUpdate,
      '[Seeding] '
    );
  } finally {
    if (!win.isDestroyed()) {
      closedByAutomation = true;
      win.close();
    }
  }
}
