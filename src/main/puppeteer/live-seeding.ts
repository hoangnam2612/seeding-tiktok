import { Page } from 'puppeteer-core';
import { TaskLogItem } from '../nest/automation/automation.interface';

export interface LiveSeedingOptions {
  page: Page;
  liveUrl: string;
  accountId: string;
  username?: string;
  likeCount?: number;
  comments?: string[];
  durationMinutes?: number;
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void;
  isCancelled?: () => boolean;
}

export interface LiveSeedingResult {
  success: boolean;
  likedCount: number;
  commentedCount: number;
  message?: string;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Execute Livestream Seeding (Tap like screen & Chat comment) on real Google Chrome
 */
export async function performPuppeteerLiveSeeding(
  options: LiveSeedingOptions
): Promise<LiveSeedingResult> {
  const {
    page,
    liveUrl,
    accountId,
    username,
    likeCount = 20,
    comments = [],
    durationMinutes = 1,
    onLog,
    isCancelled = () => false,
  } = options;

  const result: LiveSeedingResult = {
    success: false,
    likedCount: 0,
    commentedCount: 0,
  };

  if (isCancelled()) return { success: false, likedCount: 0, commentedCount: 0, message: 'Cancelled' };

  onLog({
    accountId,
    accountUsername: username,
    level: 'info',
    message: `🔴 Đang tham gia Livestream: ${liveUrl}`,
  });

  try {
    await page.goto(liveUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (err: any) {
    onLog({
      accountId,
      accountUsername: username,
      level: 'warning',
      message: `⚠️ Điều hướng Livestream mất nhiều thời gian: ${err?.message || 'Timeout'}`,
    });
  }

  await delay(3000);
  if (isCancelled()) return result;

  const maxDurationMs = Math.max(1, durationMinutes) * 60 * 1000;
  const startTime = Date.now();

  // 1. Perform Tap Likes on Live screen
  if (likeCount > 0) {
    onLog({
      accountId,
      accountUsername: username,
      level: 'info',
      message: `🔥 Bắt đầu thả tim liên tục (${likeCount} tim)...`,
    });

    const targetLikes = Math.min(likeCount, 100);
    for (let i = 0; i < targetLikes; i++) {
      if (isCancelled() || Date.now() - startTime > maxDurationMs) break;

      await page.evaluate(() => {
        const liveScreen = document.querySelector(
          '[class*="LivePlayerContainer"], [class*="DivPlayerContainer"], video, #tiktok-live-main-container-id'
        ) as HTMLElement;
        if (liveScreen) {
          const rect = liveScreen.getBoundingClientRect();
          const evt = new MouseEvent('click', {
            bubbles: true,
            clientX: rect.left + rect.width / 2 + (Math.random() * 40 - 20),
            clientY: rect.top + rect.height / 2 + (Math.random() * 40 - 20),
          });
          liveScreen.dispatchEvent(evt);
        }
      }).catch(() => {});

      result.likedCount++;
      await delay(Math.floor(Math.random() * 150) + 120);
    }

    onLog({
      accountId,
      accountUsername: username,
      level: 'success',
      message: `❤️ Đã thả ${result.likedCount} tim vào Livestream!`,
    });
  }

  // 2. Perform Live Chat Comment
  const validComments = (comments || []).filter(c => c && c.trim().length > 0);
  if (validComments.length > 0) {
    if (isCancelled() || Date.now() - startTime > maxDurationMs) return result;

    const chatText = validComments[Math.floor(Math.random() * validComments.length)].trim();
    onLog({
      accountId,
      accountUsername: username,
      level: 'info',
      message: `💬 Đang gửi tin nhắn Live: "${chatText}"...`,
    });

    try {
      const inputSelector = await page.evaluate(() => {
        const selectors = [
          '[placeholder*="Say something nice"]',
          '[placeholder*="Nói điều gì đó"]',
          '[data-e2e="comment-input"]',
          '[contenteditable="plaintext-only"]',
          '[contenteditable="true"]',
        ];
        for (const sel of selectors) {
          if (document.querySelector(sel)) return sel;
        }
        return null;
      });

      if (inputSelector) {
        await page.click(inputSelector);
        await delay(300);
        await page.keyboard.type(chatText, { delay: 50 });
        await delay(300);
        await page.keyboard.press('Enter');
        result.commentedCount++;

        onLog({
          accountId,
          accountUsername: username,
          level: 'success',
          message: `💬 Đã gửi bình luận Live thành công: "${chatText}"!`,
        });
      }
    } catch (err: any) {
      onLog({
        accountId,
        accountUsername: username,
        level: 'warning',
        message: `⚠️ Lỗi khi chat Livestream: ${err?.message || err}`,
      });
    }
  }

  result.success = result.likedCount > 0 || result.commentedCount > 0;
  return result;
}
