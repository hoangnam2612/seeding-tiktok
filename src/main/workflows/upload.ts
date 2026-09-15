import { Page } from 'playwright-core';
import { Product, UploadConfig, UploadItem } from './contracts';
import { buildCaption, isTikTokUrl } from './validation';
import { check, delay, until } from './control';
import { clickOptional, find, requireElement } from './browser';

const anchorSelector = "[class*='anchor-tag-container'], [data-e2e='anchor_container']";
const productSearch = "[class*='product-selector-container'] input[class*='TUXTextInputCore-input']";
const productFooter = "[class*='common-modal-footer'] button[class*='TUXButton--primary'], [class*='anchor-modal'] button[class*='TUXButton--primary']";
async function anchorText(page: Page) { const anchor = await find(page, anchorSelector); return anchor ? (await anchor.innerText()).trim() : ''; }
export async function attachProduct(page: Page, product: Product, signal: AbortSignal) {
  if (!/^\d+$/.test(product.id)) throw new Error('ID sản phẩm phải là số.');
  const before = await anchorText(page);
  await (await requireElement(page, "[class*='anchor-tag-container'] [class*='add-more-btn'], [class*='anchor-tag-container'] [class*='add-first-btn'], [data-e2e='anchor_container'] button[data-type='neutral']", signal, 'Không tìm thấy chức năng gắn sản phẩm.')).click();
  let typeConfirmed = false, tabSelected = false;
  const search = await until(async () => {
    const input = await find(page, productSearch); if (input) return input;
    if (!tabSelected) tabSelected = await clickOptional(page, "[aria-orientation='horizontal'] [id='2'] button", signal);
    if (!typeConfirmed && !await find(page, "[class*='product-selector-container']")) typeConfirmed = await clickOptional(page, "[role='dialog'] button[class*='TUXButton--primary']", signal);
    return undefined;
  }, signal, 30000, 'Không mở được ô tìm sản phẩm.');
  await search.fill(product.id); await search.press('Enter');
  const row = await requireElement(page, `[class*='product-selector-container'] tr:has(:text-is("${product.id}"))`, signal, 'Không tìm thấy đúng ID sản phẩm.', 25000);
  const choice = row.locator("input[type='radio'], input[type='checkbox'], [role='radio'], [role='checkbox']").first();
  if (!await choice.count() || !await choice.isEnabled() || await choice.getAttribute('aria-disabled') === 'true') throw new Error('Sản phẩm không đủ điều kiện để chọn.');
  const selected = () => choice.evaluate(el => (el as HTMLInputElement).checked === true || el.getAttribute('aria-checked') === 'true');
  if (!await selected()) await choice.evaluate(el => (el as HTMLElement).click());
  if (!await selected()) throw new Error('TikTok chưa xác nhận chọn sản phẩm.');
  await (await requireElement(page, productFooter, signal, 'Không tìm thấy nút xác nhận sản phẩm.')).click();
  let nameFilled = false;
  await until(async () => {
    const error = await find(page, "[class*='anchor-modal'] [class*='TUXFormField-error'], [role='dialog'] [class*='TUXFormField-error']");
    if (error && (await error.innerText()).trim()) throw new Error('TikTok báo lỗi: ' + await error.innerText());
    const name = await find(page, "input[class*='TUXTextInputCore-input'][aria-describedby*='_description']");
    if (name && !nameFilled) { if (product.displayName.trim()) await name.fill(product.displayName); nameFilled = true; await (await requireElement(page, productFooter, signal, 'Không xác nhận được tên sản phẩm.')).click(); return false; }
    const editor = await find(page, [productSearch, "input[aria-describedby*='_description']", productFooter]);
    const after = await anchorText(page);
    return !editor && !!after && after !== before;
  }, signal, 20000, 'Chưa xác nhận được sản phẩm đã gắn. Video chưa được đăng.');
}
export async function dismissUploadDialogs(page: Page, signal: AbortSignal, afterPost = false) {
  for (const frame of page.frames()) {
    const dialogs = frame.locator("[role='dialog'], [class*='Modal'], [class*='modal']");
    for (let i = 0; i < await dialogs.count(); i++) {
      const dialog = dialogs.nth(i); if (!await dialog.isVisible()) continue;
      const text = await dialog.innerText();
      const pattern = /local draft|bản nháp/i.test(text) ? /^(Discard|Cancel|Hủy|Bỏ qua)$/i
        : /automatic content check|copyright check|kiểm tra nội dung/i.test(text) ? /^(Not now|Để sau|Cancel|Hủy)$/i
        : /got it|đã hiểu/i.test(text) ? /^(Got it|Đã hiểu|OK)$/i
        : afterPost && /continue to post|checking your video/i.test(text) ? /^(Post now|Đăng ngay)$/i : null;
      if (pattern) { const button = dialog.getByRole('button', { name: pattern }).first(); if (await button.isVisible().catch(() => false)) { check(signal); await button.click(); } }
    }
  }
}
async function profileVideos(page: Page, username: string, signal: AbortSignal): Promise<Set<string> | undefined> {
  if (!/^[\w.]+$/.test(username)) return;
  const tab = await page.context().newPage();
  try {
    await tab.goto('https://www.tiktok.com/@' + encodeURIComponent(username), { waitUntil: 'domcontentloaded', timeout: 15000 });
    await requireElement(tab, "[data-e2e='user-post-item-list'], [data-e2e='user-post-item'], [data-e2e='user-post-item-empty'], [data-e2e='user-post-item-list-empty']", signal, 'Chưa tải được danh sách bài đăng.', 10000);
    const urls = await tab.locator("[data-e2e='user-post-item'] a[href*='/video/'], a[data-e2e='user-post-item'][href*='/video/']").evaluateAll(nodes => nodes.map(node => (node as HTMLAnchorElement).href));
    return new Set(urls.filter(isTikTokUrl));
  } catch { check(signal); return; }
  finally { await tab.close().catch(() => {}); }
}
export async function uploadVideo(page: Page, item: UploadItem, config: UploadConfig, signal: AbortSignal, log: (message: string) => void, username?: string): Promise<{ url?: string; message: string }> {
  check(signal); await dismissUploadDialogs(page, signal);
  const previous = username ? await profileVideos(page, username.replace(/^@/, ''), signal) : undefined;
  const input = await requireElement(page, "input[type='file']", signal, 'Không tìm thấy ô chọn file video.', 30000, false);
  log(`Đang tải video: ${item.title}`); await input.setInputFiles(item.path);
  const postSelector = "button[data-e2e='post_video_button'], [class*='btn-post'] button, button:text-is('Post'), button:text-is('Đăng')";
  await until(async () => {
    await dismissUploadDialogs(page, signal);
    const post = await find(page, postSelector);
    return post && await post.isEnabled() && await post.getAttribute('aria-disabled') !== 'true';
  }, signal, config.uploadTimeoutSeconds * 1000, 'Hết thời gian chờ tải hoặc xử lý video.');
  const caption = await requireElement(page, "[data-e2e='caption_container'] [contenteditable], [contenteditable='true']", signal, 'Không tìm thấy ô mô tả.');
  await caption.fill(buildCaption(item, config));
  for (const raw of config.tags.slice(0, config.maxTags)) {
    const username = raw.trim().replace(/^@/, ''); if (!/^[\w.]+$/.test(username)) throw new Error('Username cần tag không hợp lệ.');
    await caption.press('End'); await caption.pressSequentially(' @' + username, { delay: 40 });
    const suggestion = await requireElement(page, `[data-e2e*='mention'] :text-is(${JSON.stringify(username)}), [role='listbox'] :text-is(${JSON.stringify(username)}), [class*='mention'] :text-is(${JSON.stringify(username)})`, signal, 'Không tìm thấy tài khoản cần tag: ' + username, 10000);
    await suggestion.click();
  }
  if (config.setPublicVisibility) {
    const selector = "[data-e2e='video_visibility_container'] button, [data-e2e='video_visibility_container'] [role='combobox']";
    const control = await requireElement(page, selector, signal, 'Không xác nhận được quyền xem video.');
    if (!/public|everyone|công khai|mọi người/i.test(await control.innerText())) {
      await control.click();
      await (await requireElement(page, "[role='option']:has-text('Public'), [role='option']:has-text('Everyone'), [role='option']:has-text('Công khai'), [role='option']:has-text('Mọi người')", signal, 'Không tìm thấy quyền xem công khai.')).click();
      if (!/public|everyone|công khai|mọi người/i.test(await control.innerText())) throw new Error('Chưa xác nhận quyền xem công khai.');
    }
  }
  if (config.attachProducts) { if (!item.product) throw new Error('Video chưa được ghép sản phẩm.'); log('Đang gắn sản phẩm ' + item.product.id); await attachProduct(page, item.product, signal); }
  check(signal); log('Đang đăng video.');
  // No automatic retry of the publish click: a timeout may follow a successful server write.
  await (await requireElement(page, postSelector, signal, 'Không tìm thấy nút đăng.')).click();
  const result = await until(async () => {
    await dismissUploadDialogs(page, signal, true);
    const error = await find(page, "[data-e2e='upload-error'], [role='alert']");
    if (error && /failed|error|thất bại|lỗi/i.test(await error.innerText())) throw new Error('TikTok báo lỗi đăng video: ' + await error.innerText());
    const confirmation = await find(page, ["[data-e2e='upload-success']", ":text('You can manage your posts or upload another video')", ":text('Your video has been uploaded')", ":text('Your videos are being posted to TikTok')", ":text('Video của bạn đã được tải lên')", ":text('Tải video khác lên')"]);
    if (!confirmation) return undefined;
    const link = await find(page, "[data-e2e='upload-success'] a[href*='/video/'], a[data-e2e='new-video-link']");
    const url = link ? await link.getAttribute('href') : undefined;
    return { url: url && isTikTokUrl(url) ? url : undefined, message: 'TikTok đã xác nhận đăng video.' };
  }, signal, config.postWaitSeconds * 1000, 'Đã bấm đăng nhưng chưa nhận được xác nhận. Kiểm tra TikTok trước khi chạy lại để tránh đăng trùng.');
  if (!result.url && previous && username) {
    const deadline = Date.now() + Math.max(10, config.postWaitSeconds) * 1000;
    do {
      const current = await profileVideos(page, username.replace(/^@/, ''), signal);
      const added = current ? [...current].filter(url => !previous.has(url)) : [];
      if (added.length === 1) return { ...result, url: added[0] };
      if (added.length > 1 || !current) break;
      await delay(2000, signal);
    } while (Date.now() < deadline);
  }
  return result;
}
