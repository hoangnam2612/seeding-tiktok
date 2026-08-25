import { Page } from 'puppeteer-core';
import { TaskLogItem } from '../nest/automation/automation.interface';
import { TIKTOK_INNER_CONTENT_ZOOM } from './window-bounds';

export interface VideoSeedingOptions {
  page: Page;
  videoUrl: string;
  accountId: string;
  username?: string;
  like?: boolean;
  comments?: string[];
  followAuthor?: boolean;
  watchSeconds?: number;
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void;
  isCancelled?: () => boolean;
}

export interface VideoSeedingResult {
  success: boolean;
  liked?: boolean;
  commented?: boolean;
  commentText?: string;
  followed?: boolean;
  watchedSeconds?: number;
  message?: string;
}

/**
 * Random delay helper
 */
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Human-like typing into contenteditable element
 */
async function humanTypeContentEditable(page: Page, selector: string, text: string) {
  await page.waitForSelector(selector, { visible: true, timeout: 8000 });
  await page.click(selector);
  await delay(300);

  // Clear existing text if any
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) {
      el.textContent = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, selector);
  await delay(200);

  // Type characters with slight jitter
  for (const char of text) {
    await page.keyboard.type(char, { delay: Math.floor(Math.random() * 60) + 40 });
  }

  await delay(400);
}

/**
 * Execute Video Seeding Actions on a TikTok video page (100% real Google Chrome / Puppeteer)
 */
export async function performPuppeteerVideoSeeding(
  options: VideoSeedingOptions
): Promise<VideoSeedingResult> {
  const {
    page,
    videoUrl,
    accountId,
    username,
    like = true,
    comments = [],
    followAuthor = false,
    watchSeconds = 6,
    onLog,
    isCancelled = () => false,
  } = options;

  const result: VideoSeedingResult = {
    success: false,
    liked: false,
    commented: false,
    followed: false,
    watchedSeconds: 0,
  };

  if (isCancelled()) {
    return { success: false, message: 'Seeding task was cancelled' };
  }

  // 1. Navigate to Video URL
  onLog({
    accountId,
    accountUsername: username,
    level: 'info',
    message: `🎬 Đang điều hướng đến Video: ${videoUrl}`,
  });

  try {
    await page.goto(videoUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 40000,
    });
    await page.evaluate((zoomValue) => {
      try {
        (document.documentElement as HTMLElement).style.zoom = zoomValue;
        if (document.body) {
          (document.body as HTMLElement).style.zoom = zoomValue;
        }
      } catch {}
    }, TIKTOK_INNER_CONTENT_ZOOM).catch(() => {});
  } catch (err: any) {
    onLog({
      accountId,
      accountUsername: username,
      level: 'warning',
      message: `⚠️ Tải trang mất nhiều thời gian: ${err?.message || 'Timeout'}. Tiếp tục thực hiện...`,
    });
  }

  await delay(2000);
  if (isCancelled()) return { success: false, message: 'Cancelled' };

  // 2. Watch video for specified duration (Simulate human watching)
  const actualWatch = Math.max(3, watchSeconds);
  onLog({
    accountId,
    accountUsername: username,
    level: 'info',
    message: `👀 Đang xem video ${actualWatch}s (mô phỏng người dùng thật)...`,
  });

  // Small mouse movements while watching
  const startTime = Date.now();
  while (Date.now() - startTime < actualWatch * 1000) {
    if (isCancelled()) return { success: false, message: 'Cancelled' };
    await page.mouse.move(
      Math.floor(Math.random() * 200) + 100,
      Math.floor(Math.random() * 200) + 150
    ).catch(() => {});
    await delay(1500);
  }
  result.watchedSeconds = actualWatch;

  // 3. Like Video (Tim Video)
  if (like) {
    if (isCancelled()) return { success: false, message: 'Cancelled' };

    try {
      // Check if already liked
      const alreadyLiked = await page.evaluate(() => {
        const likeBtn = document.querySelector(
          '[data-e2e="like-icon"], [data-e2e="browse-like-icon"], button[aria-label*="Like"], button[aria-label*="Thích"]'
        );
        if (!likeBtn) return false;
        const svg = likeBtn.querySelector('svg');
        const path = likeBtn.querySelector('path');
        const fill = (svg?.getAttribute('fill') || path?.getAttribute('fill') || '').toLowerCase();
        const color = (svg?.getAttribute('color') || '').toLowerCase();
        return (
          fill.includes('254, 44, 85') ||
          fill.includes('254,44,85') ||
          fill.includes('fe2c55') ||
          color.includes('254, 44, 85') ||
          likeBtn.getAttribute('aria-pressed') === 'true'
        );
      });

      if (alreadyLiked) {
        result.liked = true;
        onLog({
          accountId,
          accountUsername: username,
          level: 'info',
          message: `❤️ Video đã được Thả Tim từ trước.`,
        });
      } else {
        const likedSuccess = await page.evaluate(() => {
          const selectors = [
            '[data-e2e="like-icon"]',
            '[data-e2e="browse-like-icon"]',
            'span[data-e2e="like-icon"]',
            'button[aria-label*="Like"]',
            'button[aria-label*="Thích"]',
            'strong[data-e2e="like-count"]',
          ];

          for (const sel of selectors) {
            const el = document.querySelector(sel) as HTMLElement;
            if (el) {
              const target = el.closest('button') || el;
              target.click();
              return true;
            }
          }
          return false;
        });

        if (likedSuccess) {
          result.liked = true;
          onLog({
            accountId,
            accountUsername: username,
            level: 'success',
            message: `❤️ Đã Thả Tim Video thành công!`,
          });
        } else {
          onLog({
            accountId,
            accountUsername: username,
            level: 'warning',
            message: `⚠️ Không tìm thấy nút Like trên giao diện video.`,
          });
        }
      }
    } catch (err: any) {
      onLog({
        accountId,
        accountUsername: username,
        level: 'warning',
        message: `⚠️ Lỗi khi thả tim video: ${err?.message || err}`,
      });
    }

    await delay(Math.floor(Math.random() * 1000) + 1200);
  }

  // 4. Comment on Video (Bình luận Video)
  const validComments = (comments || []).filter(c => c && c.trim().length > 0);
  if (validComments.length > 0) {
    if (isCancelled()) return { success: false, message: 'Cancelled' };

    const selectedComment = validComments[Math.floor(Math.random() * validComments.length)].trim();
    result.commentText = selectedComment;

    onLog({
      accountId,
      accountUsername: username,
      level: 'info',
      message: `💬 Đang chuẩn bị gửi bình luận: "${selectedComment}"...`,
    });

    try {
      // Find comment box selector
      const commentBoxSelector = await page.evaluate(() => {
        const inputSelectors = [
          '[data-e2e="comment-input"] [contenteditable="true"]',
          'div[contenteditable="true"][data-e2e="comment-input"]',
          '[data-e2e="comment-input"]',
          'div[contenteditable="true"]',
          '[class*="DivCommentInput"] [contenteditable="true"]',
          '[placeholder*="Add comment"]',
          '[placeholder*="Thêm bình luận"]',
        ];

        for (const sel of inputSelectors) {
          const el = document.querySelector(sel);
          if (el) return sel;
        }
        return null;
      });

      if (commentBoxSelector) {
        await humanTypeContentEditable(page, commentBoxSelector, selectedComment);
        await delay(600);

        // Click post button or press Enter
        const posted = await page.evaluate(() => {
          const postButtons = [
            '[data-e2e="comment-post"]',
            'button[data-e2e="comment-post"]',
            'div[data-e2e="comment-post"]',
            '[class*="ButtonPost"]',
            'button[type="submit"]',
          ];

          for (const btnSel of postButtons) {
            const btn = document.querySelector(btnSel) as HTMLElement;
            if (btn && !btn.hasAttribute('disabled') && btn.getAttribute('aria-disabled') !== 'true') {
              btn.click();
              return true;
            }
          }
          return false;
        });

        if (!posted) {
          // Fallback: Press Enter key
          await page.keyboard.press('Enter');
        }

        await delay(2000);
        result.commented = true;
        onLog({
          accountId,
          accountUsername: username,
          level: 'success',
          message: `💬 Đã gửi bình luận thành công: "${selectedComment}"!`,
        });
      } else {
        onLog({
          accountId,
          accountUsername: username,
          level: 'warning',
          message: `⚠️ Không tìm thấy ô nhập bình luận trên trang (có thể cần đăng nhập lại hoặc video tắt cmt).`,
        });
      }
    } catch (err: any) {
      onLog({
        accountId,
        accountUsername: username,
        level: 'warning',
        message: `⚠️ Lỗi khi đăng bình luận: ${err?.message || err}`,
      });
    }

    await delay(Math.floor(Math.random() * 1000) + 1500);
  }

  // 5. Follow Video Author if requested
  if (followAuthor) {
    if (isCancelled()) return { success: false, message: 'Cancelled' };

    try {
      const followed = await page.evaluate(() => {
        const followSelectors = [
          '[data-e2e="browse-follow"]',
          'button[data-e2e="follow-button"]',
          '[data-e2e="feed-follow"]',
        ];

        for (const sel of followSelectors) {
          const btn = document.querySelector(sel) as HTMLElement;
          if (btn && !btn.textContent?.toLowerCase().includes('following') && !btn.textContent?.toLowerCase().includes('đang follow')) {
            btn.click();
            return true;
          }
        }
        return false;
      });

      if (followed) {
        result.followed = true;
        onLog({
          accountId,
          accountUsername: username,
          level: 'success',
          message: `➕ Đã Follow tác giả video thành công!`,
        });
      }
    } catch (err: any) {
      onLog({
        accountId,
        accountUsername: username,
        level: 'warning',
        message: `⚠️ Lỗi khi follow tác giả: ${err?.message || err}`,
      });
    }
  }

  result.success = !!(result.liked || result.commented || result.followed || (result.watchedSeconds && result.watchedSeconds > 0));
  return result;
}
