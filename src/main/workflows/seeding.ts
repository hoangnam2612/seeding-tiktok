import { Page, Locator } from 'playwright-core';
import { VideoConfig, LiveConfig } from './contracts';
import { randomInt, spinText } from './validation';
import { check, delay, until } from './control';
import { clickOptional, find, requireElement } from './browser';

async function active(target: Locator, kind: 'like' | 'favorite'): Promise<boolean> {
  return target.evaluate((el, action) => {
    const root = el.closest('button, [role="button"]') || el;
    const label = (root.getAttribute('aria-label') || '').toLowerCase();
    if (root.getAttribute('aria-pressed') === 'true' || root.getAttribute('data-active') === 'true') return true;
    if (action === 'like' && /unlike|bỏ thích/.test(label)) return true;
    if (action === 'favorite' && /remove|bỏ lưu|xóa khỏi/.test(label)) return true;
    const colors = Array.from(root.querySelectorAll('svg, path')).map(node => (node.getAttribute('fill') || getComputedStyle(node).fill || '').toLowerCase().replace(/\s/g, ''));
    return action === 'like' ? colors.some(c => ['#fe2c55', 'rgb(254,44,85)', '#ff2c55'].includes(c)) : colors.some(c => ['#face15', 'rgb(250,206,21)', '#facd15'].includes(c));
  }, kind);
}
export async function toggleVideoAction(page: Page, kind: 'like' | 'favorite', signal: AbortSignal) {
  const selectors = kind === 'like' ? "[data-e2e='like-icon'], [data-e2e='browse-like-icon'], button[aria-label='Like'], button[aria-label='Unlike']" : "[data-e2e='undefined-icon'], [data-e2e='collect-icon'], [data-e2e='favorite-icon'], button[aria-label*='Favorites']";
  const target = await requireElement(page, selectors, signal, kind === 'like' ? 'Không tìm thấy nút tim.' : 'Không tìm thấy nút yêu thích.');
  if (await active(target, kind)) return;
  await target.click();
  await until(() => active(target, kind), signal, 5000, 'Chưa xác nhận được thao tác ' + kind + '; không bấm lặp lại.');
}
export async function follow(page: Page, signal: AbortSignal) {
  const selectors = "[data-e2e='follow-button'], [data-e2e='browse-follow'] button, [data-e2e='room-follow-btn'], [data-e2e='feed-follow'], button[aria-label='Follow'], button:text-is('Follow'), button:text-is('Theo dõi')";
  const followed = (text: string) => /following|đang theo dõi|friends|bạn bè/i.test(text);
  for (let attempt = 0; attempt < 5; attempt++) {
    check(signal);
    const targets = page.locator(selectors); let target: Locator | undefined;
    for (let i = 0; i < await targets.count(); i++) {
      const candidate = targets.nth(i);
      if (await candidate.isVisible() && await candidate.isEnabled() && !followed(await candidate.innerText()) && await candidate.getAttribute('data-state') !== 'following') { target = candidate; break; }
    }
    if (!target) {
      if (await find(page, "[data-e2e='follow-button'][data-state='following'], [data-e2e='follow-button']:has-text('Following'), [data-e2e='browse-follow']:has-text('Following'), button:text-is('Following'), button:text-is('Đang theo dõi')")) return;
      if (attempt < 4) { await delay(1500, signal); continue; }
      throw new Error('Không tìm thấy nút Follow đúng trên video.');
    }
    await target.click();
    try {
      await until(async () => followed(await target!.innerText().catch(() => '')) || await target!.getAttribute('data-state').catch(() => '') === 'following', signal, 8000, 'Chưa xác nhận được Follow.'); return;
    } catch (error) {
      check(signal);
      // Refresh the page to reconcile server state before any further click.
      if (attempt === 4) throw error;
      await page.reload({ waitUntil: 'domcontentloaded' });
    }
  }
}
export async function sendComment(page: Page, text: string, live: boolean, signal: AbortSignal) {
  if (!text.trim()) return;
  const selectors = live ? "[data-e2e='room-chat-input-field'], [contenteditable='plaintext-only'][data-e2e*='chat']" : "[data-e2e='comment-input'] [contenteditable], [data-e2e='comment-input'][contenteditable], [data-e2e='comment-input'] textarea, [data-e2e='comment-text'][contenteditable], [contenteditable][data-placeholder*='comment']";
  if (!live && !await find(page, selectors)) await clickOptional(page, "[data-e2e='comment-icon'], [data-e2e='browse-comment-icon']", signal);
  const input = await requireElement(page, selectors, signal, 'Không tìm thấy ô bình luận.');
  await input.fill(text);
  const send = live ? "[data-e2e='room-chat-send-btn']" : "[data-e2e='comment-post'], [data-e2e='comment-post-button'], button:text-is('Post'), button:text-is('Đăng')";
  if (!await clickOptional(page, send, signal)) { if (live) await input.press('Enter'); else throw new Error('Không tìm thấy nút gửi bình luận.'); }
  await until(async () => {
    const value = await input.evaluate(el => 'value' in el ? String((el as HTMLInputElement).value) : el.textContent || '');
    return value.trim() === '';
  }, signal, 6000, 'Chưa xác nhận gửi bình luận; không gửi lại tự động.');
}
export async function seedVideo(page: Page, config: VideoConfig, signal: AbortSignal, log: (message: string) => void, ready: () => Promise<void> = async () => {}) {
  const watch = randomInt(config.minViewSeconds, config.maxViewSeconds);
  log(`Đang xem video ${watch} giây.`); await delay(watch * 1000, signal);
  const pause = () => delay(randomInt(config.minDelaySeconds, config.maxDelaySeconds) * 1000, signal);
  let failures = 0;
  const action = async (work: () => Promise<void>) => { await ready(); try { await work(); } catch (error) { check(signal); failures++; log('Cảnh báo: ' + (error as Error).message); } await pause(); };
  if (config.isLike) await action(() => toggleVideoAction(page, 'like', signal));
  if (config.isFollow) await action(() => follow(page, signal));
  if (config.isFavorite) await action(() => toggleVideoAction(page, 'favorite', signal));
  if (config.isComment && config.comments.length) await action(() => sendComment(page, spinText(config.comments[randomInt(0, config.comments.length - 1)]), false, signal));
  return failures;
}
export async function seedLive(page: Page, config: LiveConfig, signal: AbortSignal, log: (message: string) => void, ready: () => Promise<void> = async () => {}) {
  let failures = 0;
  const action = async (work: () => Promise<void>) => { await ready(); try { await work(); } catch (error) { check(signal); failures++; log('Cảnh báo: ' + (error as Error).message); } };
  if (config.isFollowHost) await action(() => follow(page, signal));
  const seconds = randomInt(config.minWatchMinutes * 60, config.maxWatchMinutes * 60);
  log(`Đang xem livestream ${seconds} giây.`);
  const end = Date.now() + seconds * 1000;
  let nextHeart = Date.now() + 2000, nextComment = Date.now() + randomInt(5, 14) * 1000;
  while (Date.now() < end) {
    await delay(Math.min(1000, Math.max(0, end - Date.now())), signal); check(signal);
    if (Date.now() >= end) break;
    if (config.isSendHearts && Date.now() >= nextHeart) {
      await action(async () => { const heart = await requireElement(page, "[data-e2e='room-chat-like-btn']", signal, 'Không tìm thấy nút thả tim live.');
      for (let i = 0; i < config.heartClicksPerRound; i++) { check(signal); await heart.click(); await delay(randomInt(80, 149), signal); }
      log(`Đã thả ${config.heartClicksPerRound} tim.`); }); nextHeart = Date.now() + randomInt(8, 15) * 1000;
    }
    if (config.isCommentLive && config.liveComments.length && Date.now() >= nextComment) {
      await action(async () => { await sendComment(page, spinText(config.liveComments[randomInt(0, config.liveComments.length - 1)]), true, signal); log('Đã gửi bình luận live.'); });
      nextComment = Date.now() + Math.max(1, config.commentIntervalSeconds + randomInt(-3, 3)) * 1000;
    }
  }
  return failures;
}
