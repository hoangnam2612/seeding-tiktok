import { Page } from 'playwright-core';
import { TikTokAccount } from '../nest/accounts/account.interface';
import { ProfileConfig } from './contracts';
import { allocateProfile, randomInt } from './validation';
import { check, delay, until } from './control';
import { clickOptional, find, requireElement } from './browser';
import { waitForChallenge } from './login';

export async function openProfile(page: Page, username: string, signal: AbortSignal) {
  const edit = "[data-e2e='edit-profile-entrance'], button:has-text('Edit profile'), button:has-text('Sửa hồ sơ'), button:has-text('Chỉnh sửa hồ sơ')";
  if (username) {
    await page.goto('https://www.tiktok.com/@' + encodeURIComponent(username.replace(/^@/, '')), { waitUntil: 'domcontentloaded' }).catch(() => { check(signal); });
    try { await requireElement(page, edit, signal, 'Chưa mở được profile.', 4000); return; } catch { check(signal); }
  }
  const nav = await requireElement(page, "a[data-e2e='nav-profile'], [data-e2e='profile-icon'], header a[href*='/@'], aside a[href*='/@'], [data-e2e='nav-profile'] a", signal, 'Không tìm thấy thanh điều hướng Profile.');
  await nav.click(); await requireElement(page, edit, signal, 'Không mở được hồ sơ của tài khoản.');
}

export async function updateProfile(page: Page, config: ProfileConfig, chosen: ReturnType<typeof allocateProfile>, signal: AbortSignal, log: (message: string) => void): Promise<Partial<TikTokAccount>> {
  await (await requireElement(page, ["[data-e2e='edit-profile-entrance']", "button:has-text('Edit profile'), button:has-text('Sửa hồ sơ'), button:has-text('Chỉnh sửa hồ sơ')"], signal, 'Không tìm thấy nút sửa hồ sơ.')).click();
  const patch: Partial<TikTokAccount> = {};
  const warnings: string[] = [];
  if (chosen.avatar) {
    try {
    log('Đang tải ảnh đại diện.');
    await (await requireElement(page, "[data-e2e='edit-profile-avatar-edit-icon'] input[type='file'], input[type='file']", signal, 'Không tìm thấy ô chọn avatar.', 15000, false)).setInputFiles(chosen.avatar);
    await requireElement(page, "img[src^='blob:'], [class*='crop'], [class*='Crop']", signal, 'TikTok chưa hiển thị ảnh xem trước.');
    await (await requireElement(page, "button:text-is('Apply'), button:text-is('Áp dụng'), [role='dialog'] button:text-is('Done'), [role='dialog'] button:text-is('Xong')", signal, 'Không tìm thấy nút áp dụng ảnh.')).click();
    await waitForChallenge(page, signal, log); patch.avatarUrl = chosen.avatar;
    await delay(randomInt(config.minDelaySeconds, config.maxDelaySeconds) * 1000, signal);
    } catch (error) { check(signal); warnings.push('Avatar'); log('Không đổi được avatar: ' + (error as Error).message); await clickOptional(page, "[role='dialog'] button:text-is('Cancel'), [role='dialog'] button:text-is('Hủy')", signal); }
  }
  const fields = [
    { value: chosen.name, key: 'displayName', selector: "[data-e2e='edit-profile-name-input'] input, [data-e2e='edit-profile-nickname-input'] input, input[name='nickname'], input[placeholder*='Name'], input[placeholder*='Tên']", label: 'tên hiển thị' },
    { value: chosen.username, key: 'username', selector: "[data-e2e='edit-profile-username-input'] input, input[name='uniqueId'], input[placeholder*='Username']", label: 'username' },
    { value: chosen.bio, key: 'bio', selector: "[data-e2e='edit-profile-bio-input'] textarea, textarea[name='bio'], textarea[placeholder*='Bio'], textarea[placeholder*='Tiểu sử']", label: 'tiểu sử' },
  ] as const;
  for (const field of fields) if (field.value !== undefined) {
    check(signal); log(`Đang đổi ${field.label}.`);
    try {
    const input = await requireElement(page, field.selector, signal, `Không tìm thấy ô ${field.label}.`);
    await input.fill(field.value); await input.blur(); await delay(500, signal);
    const invalid = await input.getAttribute('aria-invalid');
    const error = await find(page, "[data-e2e*='edit-profile'] [class*='error'], [role='dialog'] [class*='TUXFormField-error']");
    if (invalid === 'true' || error && (await error.innerText()).trim()) throw new Error(`TikTok từ chối ${field.label}; chưa lưu các trường văn bản.`);
    patch[field.key] = field.value;
    if (field.key === 'username') patch.uid = field.value;
    await delay(randomInt(config.minDelaySeconds, config.maxDelaySeconds) * 1000, signal);
    } catch (error) { check(signal); warnings.push(field.label); log('Không đổi được ' + field.label + ': ' + (error as Error).message); }
  }
  const save = await requireElement(page, "[data-e2e='edit-profile-save'], [role='dialog'] button:text-is('Save'), [role='dialog'] button:text-is('Lưu')", signal, 'Không tìm thấy nút lưu hồ sơ.');
  await save.click();
  await clickOptional(page, "[data-e2e='set-username-popup-confirm'], [role='dialog'] button:text-is('Confirm'), [role='dialog'] button:text-is('Xác nhận')", signal);
  await waitForChallenge(page, signal, log);
  await until(async () => {
    const error = await find(page, "[role='dialog'] [class*='TUXFormField-error'], [data-e2e='edit-profile-error']");
    if (error && (await error.innerText()).trim()) throw new Error('TikTok báo lỗi khi lưu hồ sơ.');
    return !await save.isVisible() && !await find(page, "[data-e2e='edit-profile-popup'], [data-e2e='edit-profile-header'], [data-e2e='edit-profile-save']");
  }, signal, 15000, 'Chưa xác nhận được hồ sơ đã lưu.');
  if (!Object.keys(patch).length) throw new Error('Không có mục hồ sơ nào được cập nhật.');
  if (warnings.length) patch.message = 'Đã lưu các mục hợp lệ; chưa đổi: ' + warnings.join(', ');
  return patch;
}
