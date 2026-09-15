import * as fs from 'fs';
import * as path from 'path';
import { BrowserSettings, browserDefaults, Command, Config, defaults, ProfileConfig, Product, UploadConfig, UploadItem } from './contracts';

export function integer(value: unknown, name: string, min = 0, max = 86400): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${name}: nhập số nguyên từ ${min} đến ${max}.`);
  return value;
}
export function range(min: number, max: number, label: string) { integer(min, label); integer(max, label); if (max < min) throw new Error(`${label}: giá trị lớn nhất phải ≥ nhỏ nhất.`); }
export function isTikTokUrl(value: string): boolean {
  try { const u = new URL(value); return u.protocol === 'https:' && (u.hostname === 'tiktok.com' || u.hostname.endsWith('.tiktok.com')) && !u.username && !u.password && !u.port; } catch { return false; }
}
export function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error(`${label}: cần danh sách chuỗi.`);
  return value.map(v => v.trim()).filter(Boolean);
}
export function validateBrowser(value: unknown): BrowserSettings {
  const c = { ...browserDefaults, ...(value as object) };
  for (const key of ['columns', 'rows', 'maxThreads'] as const) integer(c[key], key, 1, 32);
  for (const key of ['windowWidth', 'windowHeight'] as const) integer(c[key], key, 0, 10000);
  for (const key of ['scaleFactor', 'livePageZoom'] as const) if (!Number.isFinite(c[key]) || c[key] < .5 || c[key] > 1) throw new Error(`${key}: nhập giá trị từ 0.5 đến 1.`);
  for (const key of ['autoArrangeGrid', 'disableImages', 'disableAudio'] as const) if (typeof c[key] !== 'boolean') throw new Error(`Cấu hình ${key} không hợp lệ.`);
  return Object.fromEntries(Object.keys(browserDefaults).map(key => [key, c[key]])) as unknown as BrowserSettings;
}
export function parseProducts(lines: string[]): Product[] {
  return stringList(lines, 'Sản phẩm').map(line => {
    const separator = line.indexOf('|');
    const id = (separator < 0 ? line : line.slice(0, separator)).trim();
    if (!/^\d+$/.test(id)) throw new Error('ID sản phẩm phải là số, không nhập URL.');
    return { id, displayName: separator < 0 ? '' : line.slice(separator + 1).trim() };
  });
}
export function createUploadQueue(c: UploadConfig): UploadItem[] {
  if (c.attachProducts && c.products.length !== c.videos.length) throw new Error(`Có ${c.videos.length} video nhưng có ${c.products.length} sản phẩm. Cần đúng một dòng cho mỗi video.`);
  return c.videos.map((video, i) => ({ ...video, product: c.attachProducts ? { ...c.products[i] } : undefined }));
}
export function validateConfig(command: Command, input: unknown, accountCount: number): Config {
  if (!['video', 'live', 'profile', 'upload', 'login', 'outlook'].includes(command)) throw new Error('Tác vụ không được hỗ trợ.');
  if (command === 'login' || command === 'outlook') return {};
  const config = { ...defaults[command], ...(input as object) } as any;
  for (const [key, defaultValue] of Object.entries(defaults[command])) {
    if (typeof defaultValue === 'boolean' && typeof config[key] !== 'boolean') throw new Error(`Cấu hình ${key} không hợp lệ.`);
    if (Array.isArray(defaultValue) && !['videos', 'products'].includes(key)) config[key] = stringList(config[key], key);
  }
  if (command === 'video' || command === 'live') {
    const urls = command === 'video' ? config.videoUrls : config.liveUrls;
    if (!urls.length || urls.some((url: string) => !isTikTokUrl(url))) throw new Error('Nhập URL HTTPS của TikTok, mỗi dòng một link.');
  }
  if (command === 'video') { range(config.minViewSeconds, config.maxViewSeconds, 'Thời gian xem'); range(config.minDelaySeconds, config.maxDelaySeconds, 'Thời gian nghỉ'); }
  if (command === 'live') { range(config.minWatchMinutes, config.maxWatchMinutes, 'Thời gian xem live'); integer(config.heartClicksPerRound, 'Số tim mỗi vòng', 0, 1000); integer(config.commentIntervalSeconds, 'Chu kỳ bình luận', 1); }
  if (command === 'profile') {
    const p = config as ProfileConfig;
    range(p.minDelaySeconds, p.maxDelaySeconds, 'Thời gian nghỉ'); range(p.minRandomNumber, p.maxRandomNumber, 'Số ngẫu nhiên');
    if (!p.isChangeAvatar && !p.isChangeName && !p.isChangeUsername && !p.isChangeBio) throw new Error('Chọn ít nhất một mục cần đổi.');
    if (p.isChangeAvatar && !p.avatarFiles.length && p.avatarFolder && fs.existsSync(p.avatarFolder)) p.avatarFiles = fs.readdirSync(p.avatarFolder).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).map(f => path.join(p.avatarFolder, f));
    for (const [enabled, key] of [[p.isChangeAvatar, 'avatarFiles'], [p.isChangeName, 'names'], [p.isChangeUsername, 'usernames'], [p.isChangeBio, 'bios']] as const) {
      if (p.avoidDuplicateContent) p[key] = [...new Set(p[key])];
      if (enabled && (p[key].length === 0 || (p.avoidDuplicateContent && p[key].length < accountCount))) throw new Error('Không đủ nội dung cho mục đã chọn hoặc không đủ nội dung không trùng.');
    }
    if (p.isChangeAvatar && p.avatarFiles.some(file => !fs.existsSync(file) || !fs.statSync(file).isFile())) throw new Error('Không tìm thấy ảnh avatar.');
  }
  if (command === 'upload') {
    const c = config as UploadConfig;
    if (!Array.isArray(c.videos) || !c.videos.length || c.videos.some(v => !v || typeof v.path !== 'string' || !fs.existsSync(v.path) || !fs.statSync(v.path).isFile())) throw new Error('Chưa chọn video hoặc file không tồn tại.');
    c.videos = c.videos.map(v => ({ path: path.resolve(v.path), title: String(v.title || path.basename(v.path)), description: String(v.description || ''), size: String(v.size || '') }));
    if (c.attachProducts) {
      if (!Array.isArray(c.products) || c.products.some(p => !p || typeof p.id !== 'string' || !/^\d+$/.test(p.id) || typeof p.displayName !== 'string')) throw new Error('Sản phẩm không hợp lệ.');
    } else c.products = [];
    integer(c.maxTags, 'Số tag', 0, 100); integer(c.uploadTimeoutSeconds, 'Timeout upload', 1); integer(c.postWaitSeconds, 'Chờ bài đăng', 1);
    createUploadQueue(c);
  }
  return config;
}
export function randomInt(min: number, max: number, random = Math.random) { return min + Math.floor(random() * (max - min + 1)); }
export function spinText(value: string, random = Math.random): string {
  let output = value;
  const expression = /\{([^{}]+)\}/g;
  while (/\{([^{}]+)\}/.test(output)) output = output.replace(expression, (_, contents: string) => { const choices = contents.split('|'); return choices[Math.floor(random() * choices.length)].trim(); });
  return output.trim();
}
export function buildCaption(video: UploadItem, config: UploadConfig): string {
  const source = config.useVideoDescription && video.description.trim() ? video.description : config.captions.find(c => c.trim()) || '';
  return [spinText(source), ...config.hashtags.map(h => h.trim().replace(/^#+/, '')).filter(Boolean).map(h => '#' + h)].filter(Boolean).join(' ');
}
export function allocateProfile(config: ProfileConfig, random = Math.random): { avatar?: string; name?: string; username?: string; bio?: string } {
  const take = (values: string[]) => { const index = Math.floor(random() * values.length); return config.avoidDuplicateContent ? values.splice(index, 1)[0] : values[index]; };
  return {
    avatar: config.isChangeAvatar ? take(config.avatarFiles) : undefined,
    name: config.isChangeName ? spinText(take(config.names), random) : undefined,
    username: config.isChangeUsername ? take(config.usernames) + (config.appendRandomNumber ? randomInt(config.minRandomNumber, config.maxRandomNumber, random) : '') : undefined,
    bio: config.isChangeBio ? spinText(take(config.bios), random) : undefined,
  };
}
