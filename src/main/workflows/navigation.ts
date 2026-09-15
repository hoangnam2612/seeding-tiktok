import { Page, Response } from 'playwright-core';
import { check, delay } from './control';

// Retry navigation only: never replay likes, follows or comments.
export async function openSeedingTarget(page: Page, url: string, signal: AbortSignal, log: (message: string) => void) {
  for (let attempt = 0; attempt < 3; attempt++) {
    check(signal);
    let status: number | undefined;
    const onResponse = (response: Response) => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) status = response.status();
    };
    page.on('response', onResponse);
    let failure = '';
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      check(signal);
      status = response?.status() ?? status;
      if (status !== undefined && status < 400) return;
      failure = status === undefined ? 'Không nhận được phản hồi trang.' : `HTTP ${status}`;
    } catch (error) {
      check(signal);
      failure = (error as Error).message.replace(/\u001b\[[0-9;]*m/g, '').split('Call log:')[0].trim();
    } finally {
      page.off('response', onResponse);
    }
    const retryable = status === undefined
      ? /ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_TIMED_OUT|Timeout/i.test(failure)
      : status === 408 || status >= 500;
    if (retryable && attempt < 2) {
      log(`Không tải được trang (${status ? `HTTP ${status}` : 'lỗi kết nối'}). Thử lại ${attempt + 1}/2…`);
      await delay((attempt + 1) * 2000, signal);
      continue;
    }
    const hint = status === 403 ? 'TikTok từ chối truy cập. Kiểm tra video trong Chrome của tài khoản và kết nối/proxy.'
      : status === 404 || status === 410 ? 'Video/live không còn khả dụng hoặc đường dẫn không đúng.'
      : status === 429 ? 'TikTok giới hạn lượt truy cập. Dừng và thử lại sau, giảm số luồng.'
      : 'Kiểm tra link trong Chrome của tài khoản và kết nối/proxy; phản hồi này chưa đủ để xác định nguyên nhân.';
    throw new Error(`Không mở được video/live${status ? ` (HTTP ${status})` : ''}. ${hint} Chi tiết: ${failure}`);
  }
}
