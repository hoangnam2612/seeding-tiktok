import { BrowserWindow } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { TaskLogItem } from '../nest/automation/automation.interface';
import { ensurePersistentDataDir } from '../data-dir';
import { decryptSecret } from '../secret-json';
import { performCdpClick, performCdpDrag } from './browser-control';
import { isSeedingCancelRequested, waitForSeedingDelay } from './seeding-control';

export const OMOCAPTCHA_CREATE_TASK_URL = 'https://api.omocaptcha.com/v2/createTask';
export const OMOCAPTCHA_GET_TASK_RESULT_URL = 'https://api.omocaptcha.com/v2/getTaskResult';

export type OmoTikTokWebTaskType =
  | 'TiktokSliderWebTask'
  | 'TiktokRotateWebTask'
  | 'TiktokSelectObjectWebTask'
  | 'Tiktok3DSelectObjectWebTask';

interface CaptchaStabilityProbe {
  found: boolean;
  loading?: boolean;
  signature?: string;
  rect?: { x: number; y: number; width: number; height: number };
  reason?: string;
  error?: string;
}

export function getOmoCaptchaApiKey(): string {
  if (process.env.OMOCAPTCHA_API_KEY && process.env.OMOCAPTCHA_API_KEY.trim()) {
    return process.env.OMOCAPTCHA_API_KEY.trim();
  }
  const candidatePaths = [
    path.join(ensurePersistentDataDir(), 'settings.json'),
    path.join(process.cwd(), 'data', 'settings.json'),
    path.join(process.env.APPDATA || '', 'electron-nest-react', 'data', 'settings.json'),
    path.join(process.env.APPDATA || '', 'Seeding TikTok', 'data', 'settings.json'),
  ];
  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const apiKey = decryptSecret(parsed.omocaptchaApiKey);
        if (apiKey && apiKey.trim()) {
          return apiKey.trim();
        }
      }
    } catch {}
  }
  return '';
}

export async function postOmoCaptcha(payload: any): Promise<any> {
  const res = await fetch(payload.task ? OMOCAPTCHA_CREATE_TASK_URL : OMOCAPTCHA_GET_TASK_RESULT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function getCaptchaStabilityProbe(win: BrowserWindow): Promise<CaptchaStabilityProbe> {
  if (win.isDestroyed()) return { found: false, reason: 'window-destroyed' };

  return win.webContents.executeJavaScript(`
    (() => {
      try {
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 20 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
        };

        const normalize = (s) => String(s || '').toLowerCase()
          .normalize('NFD')
          .replace(/[\\u0300-\\u036f]/g, '')
          .replace(/đ/g, 'd')
          .replace(/Đ/g, 'D')
          .replace(/\\s+/g, ' ')
          .trim();

        const isModalBox = (el) => {
          if (!isVisible(el)) return false;
          const r = el.getBoundingClientRect();
          return r.width >= 200 && r.height >= 160 && r.width <= 780 && r.height <= 780;
        };

        const selectors = [
          '#captcha-verify-container',
          '.captcha-verify-container',
          '#captcha_verify_container',
          '.captcha_verify_container',
          '.sec-captcha-container',
          '.captcha-container',
          '.verify-wrap',
          '[class*="captcha-card" i]',
          '[class*="captcha-modal" i]',
          '[class*="captcha_card" i]',
          '[class*="captcha_modal" i]',
          'iframe[src*="captcha"]',
          'iframe[src*="sec"]',
          'iframe[src*="verify"]',
          'iframe[src*="challenge"]',
          '[id*="captcha" i]',
          '[class*="captcha" i]'
        ];

        const candidates = selectors.flatMap(sel => Array.from(document.querySelectorAll(sel)));
        const captchaBox = candidates.find(isModalBox) || candidates.find(isVisible);
        if (!captchaBox) return { found: false, reason: 'captcha-not-found' };

        const boxRect = captchaBox.getBoundingClientRect();
        const bodyText = normalize(document.body?.innerText || '');
        const boxText = normalize(captchaBox.innerText || captchaBox.textContent || '');
        const loading = /loading|please wait|dang tai|đang tải|spinner|placeholder/.test(bodyText + ' ' + boxText);

        const images = Array.from(captchaBox.querySelectorAll('img')).filter(isVisible).map((img) => {
          const rect = img.getBoundingClientRect();
          return {
            src: img.currentSrc || img.src || '',
            complete: !!img.complete,
            naturalWidth: img.naturalWidth || 0,
            naturalHeight: img.naturalHeight || 0,
            rect: {
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            }
          };
        });

        const slider = Array.from(captchaBox.querySelectorAll('[role="slider"], [class*="slide" i], [class*="drag" i]'))
          .filter(isVisible)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            return {
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            };
          })[0] || null;

        const imageStillLoading = images.some(img => !img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0);
        const rect = {
          x: Math.max(0, Math.round(boxRect.left)),
          y: Math.max(0, Math.round(boxRect.top)),
          width: Math.max(20, Math.round(boxRect.width)),
          height: Math.max(20, Math.round(boxRect.height))
        };

        return {
          found: true,
          loading: loading || imageStillLoading,
          rect,
          signature: JSON.stringify({
            rect,
            text: boxText.slice(0, 240),
            images,
            slider
          })
        };
      } catch(e) {
        return { found: false, reason: 'probe-error', error: String(e) };
      }
    })();
  `).catch(err => ({ found: false, reason: 'probe-eval-failed', error: String(err) }));
}

async function waitForStableCaptchaSnapshot(
  win: BrowserWindow,
  options: { timeoutMs?: number; sampleIntervalMs?: number; stableSamples?: number } = {}
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 6500;
  const sampleIntervalMs = options.sampleIntervalMs ?? 450;
  const requiredStableSamples = options.stableSamples ?? 2;
  const deadline = Date.now() + timeoutMs;
  let lastFingerprint = '';
  let stableSamples = 0;

  while (Date.now() < deadline) {
    if (win.isDestroyed() || isSeedingCancelRequested()) return false;

    const probe = await getCaptchaStabilityProbe(win);
    if (!probe.found || !probe.rect || probe.loading) {
      lastFingerprint = '';
      stableSamples = 0;
      await waitForSeedingDelay(sampleIntervalMs, win).catch(() => undefined);
      continue;
    }

    let visualHash = '';
    try {
      const image = await win.webContents.capturePage({
        x: probe.rect.x,
        y: probe.rect.y,
        width: probe.rect.width,
        height: probe.rect.height,
      });
      visualHash = crypto.createHash('sha256').update(image.toPNG()).digest('hex');
    } catch (err) {
      visualHash = `capture-failed:${String(err)}`;
    }

    const fingerprint = `${probe.signature || ''}:${visualHash}`;
    if (fingerprint === lastFingerprint) {
      stableSamples++;
    } else {
      lastFingerprint = fingerprint;
      stableSamples = 1;
    }

    if (stableSamples >= requiredStableSamples) {
      return true;
    }

    await waitForSeedingDelay(sampleIntervalMs, win).catch(() => undefined);
  }

  return false;
}

export async function solveTikTokWebCaptchaWithOmo(
  win: BrowserWindow,
  acc: { id: string; username: string },
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void
): Promise<boolean> {
  if (win.isDestroyed() || isSeedingCancelRequested()) return false;
  const originalZoomFactor = win.webContents.getZoomFactor() || 1;
  if (originalZoomFactor !== 1) {
    win.webContents.setZoomFactor(1);
    await waitForSeedingDelay(500, win).catch(() => undefined);
  }

  try {
    const clientKey = getOmoCaptchaApiKey();
    if (!clientKey) {
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'warning',
        message: '[Captcha] ⚠️ API Key OmoCaptcha trống! Vui lòng cấu hình trong Cài Đặt để giải tự động.',
      });
      return false;
    }

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (win.isDestroyed() || isSeedingCancelRequested()) return false;

      if (attempt > 1) {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'info',
          message: `[Captcha] 🔄 Thử giải lại CAPTCHA (Lần ${attempt}/${maxAttempts}) cho @${acc.username}...`,
        });
        await waitForSeedingDelay(1500, win);
      }

      const captchaStable = await waitForStableCaptchaSnapshot(win);
      if (captchaStable) {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'info',
          message: `[Captcha] Khung CAPTCHA đã ổn định, bắt đầu chụp ảnh gửi OmoCaptcha cho @${acc.username}.`,
        });
      } else if (attempt === 1) {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'warning',
          message: `[Captcha] Khung CAPTCHA chưa ổn định sau vài giây; vẫn tiếp tục chụp theo trạng thái hiện tại để tránh kẹt task.`,
        });
      }

      const captchaData = await win.webContents.executeJavaScript(`
        (async () => {
          try {
            const isVisible = (el) => {
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 20 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
            };

            const normalize = (s) => String(s || '').toLowerCase()
              .normalize('NFD')
              .replace(/[\\u0300-\\u036f]/g, '')
              .replace(/đ/g, 'd')
              .replace(/Đ/g, 'D')
              .trim();

            const isModalBox = (el) => {
              if (!isVisible(el)) return false;
              const r = el.getBoundingClientRect();
              return r.width >= 200 && r.height >= 160 && r.width <= 750 && r.height <= 750;
            };

            const specificSelectors = [
              '#captcha-verify-container',
              '.captcha-verify-container',
              '#captcha_verify_container',
              '.captcha_verify_container',
              '.sec-captcha-container',
              '.captcha-container',
              '.verify-wrap',
              '[class*="captcha-card" i]',
              '[class*="captcha-modal" i]',
              '[class*="captcha_card" i]',
              '[class*="captcha_modal" i]',
              'iframe[src*="captcha"]',
              'iframe[src*="sec"]',
              'iframe[src*="verify"]',
              'iframe[src*="challenge"]',
              '[id*="captcha" i]',
              '[class*="captcha" i]'
            ];

            const allCandidates = specificSelectors.flatMap(sel => Array.from(document.querySelectorAll(sel)));
            let captchaBox = allCandidates.find(isModalBox);
            if (!captchaBox) {
              captchaBox = allCandidates.find(isVisible) || Array.from(document.querySelectorAll('iframe')).find(isVisible);
            }

            if (!captchaBox) return { found: false };

            const boxRect = captchaBox.getBoundingClientRect();

            const collectModalText = (root) => {
              if (!root) return '';
              let txt = (root.innerText || root.textContent || '') + ' ';
              const textEls = Array.from(root.querySelectorAll('[class*="title" i], [class*="tip" i], [class*="header" i], [class*="instruction" i], [class*="text" i], [class*="prompt" i], [class*="msg" i]')).filter(isVisible);
              textEls.forEach(el => { txt += ' ' + (el.innerText || el.textContent || ''); });
              const iframes = Array.from(root.querySelectorAll('iframe')).filter(isVisible);
              iframes.forEach(f => {
                txt += ' ' + (f.title || f.getAttribute('aria-label') || '');
              });
              return normalize(txt);
            };

            // Check if a slider button exists inside the captcha box
            const specificSliderSelectors = [
              '.captcha_verify_slide--slidebtn',
              '.sec-captcha-slider-btn',
              '[class*="slidebtn" i]',
              '[class*="slider-btn" i]',
              '[class*="drag-btn" i]',
              '[class*="sec-slider" i]',
              '[class*="slider-thumb" i]',
              '[role="slider"]',
              'div[class*="btn" i][class*="slide" i]',
              'div[class*="button" i][class*="slide" i]'
            ];
            let sliderEl = specificSliderSelectors
              .flatMap(sel => Array.from(captchaBox.querySelectorAll(sel)))
              .find(isVisible);

            if (!sliderEl) {
              const fallbackSliders = Array.from(captchaBox.querySelectorAll('div, span, button, [role="button"]')).filter(el => {
                if (!isVisible(el)) return false;
                const r = el.getBoundingClientRect();
                return r.width >= 24 && r.width <= 65 && r.height >= 24 && r.height <= 65 &&
                       r.top >= boxRect.bottom - 120 && r.bottom <= boxRect.bottom + 20;
              });
              sliderEl = fallbackSliders.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
            }

            const hasSlider = !!sliderEl;

            const detectTaskType = (root) => {
              const modalText = collectModalText(root);
              const allImgs = Array.from(root.querySelectorAll('img')).filter(isVisible);
              const hasTwoImages = allImgs.length >= 2;
              const hasCircleOrRotateImg = !!root.querySelector(
                '[class*="circle" i], [class*="round" i], [class*="rotate" i], img[class*="inner" i], img[class*="outer" i], div[style*="50%"], [id*="rotate" i]'
              );
              const hasRotateKeyword = /rotate|xoay|angle|upright|thang dung|dung chieu|goc quay|chieu dung|fit the shape|fit the puzzle|khop hinh/.test(modalText);

              // If there is a slider button: it is either Rotate or Slider puzzle
              if (hasSlider) {
                if (hasCircleOrRotateImg || hasRotateKeyword || (hasTwoImages && modalText.includes('puzzle'))) {
                  return 'TiktokRotateWebTask';
                }
                return 'TiktokSliderWebTask';
              }

              // If there is NO slider button: it is a click/selection task (3D or Order)
              if (/3d|three[- ]?d|same object|same shape|matching object|2 doi tuong|hai doi tuong|cung hinh|cung doi tuong|giong nhau|khop vat the|2 vat the|vat the giong/.test(modalText)) {
                return 'Tiktok3DSelectObjectWebTask';
              }
              if (/select.*order|pick.*order|chon theo thu tu|chon doi tuong|chon vat the|chon hinh/.test(modalText)) {
                return 'TiktokSelectObjectWebTask';
              }
              if (/select|choose|pick|chon/.test(modalText) && /object|vat the|hinh|doi tuong/.test(modalText)) {
                return 'TiktokSelectObjectWebTask';
              }

              return 'Tiktok3DSelectObjectWebTask';
            };

            const taskType = detectTaskType(captchaBox);

            const imgSelectors = [
              '#captcha-verify-image',
              '.captcha-verify-image',
              '.captcha_verify_img--wrapper',
              'img[src*="byteoversea"]',
              'img[src*="tiktokcdn"]',
              'img[src*="captcha"]',
              'img[src*="verify"]',
              'canvas',
              'div[class*="img" i]',
              'div[class*="image" i]'
            ];
            const challengeImg = imgSelectors.flatMap(s => Array.from(captchaBox.querySelectorAll(s)))
              .concat(imgSelectors.flatMap(s => Array.from(document.querySelectorAll(s))))
              .find(el => {
                if (!isVisible(el)) return false;
                const r = el.getBoundingClientRect();
                return r.width >= 120 && r.height >= 80 && r.top >= boxRect.top - 50 && r.bottom <= boxRect.bottom + 50;
              });

            const targetEl = challengeImg || captchaBox;
            const targetRect = targetEl.getBoundingClientRect();

            // Slider button and track
            const sliderRect = sliderEl ? sliderEl.getBoundingClientRect() : null;

            // 2. Locate the EXACT track element directly hosting the slider button
            let trackEl = null;
            if (sliderEl) {
              // Check if parent or closest container is the track bar (height 20-55px, width > 150px)
              let parent = sliderEl.parentElement;
              while (parent && parent !== captchaBox && parent !== document.body) {
                const pr = parent.getBoundingClientRect();
                if (pr.width >= 160 && pr.height >= 20 && pr.height <= 65 && Math.abs(pr.top - (sliderRect?.top || 0)) <= 15) {
                  trackEl = parent;
                  break;
                }
                parent = parent.parentElement;
              }
            }

            if (!trackEl) {
              const specificTrackSelectors = [
                '.captcha_verify_slide--slidebar',
                '.sec-captcha-slider-track',
                '[class*="slidebar" i]',
                '[class*="slider-track" i]',
                '[class*="slider-bg" i]',
                '[class*="drag-bar" i]',
                '[class*="slide_bar" i]',
                '[class*="drag-track" i]',
                '[class*="rail" i]'
              ];
              trackEl = specificTrackSelectors
                .flatMap(sel => Array.from(captchaBox.querySelectorAll(sel)))
                .find(el => {
                  if (!isVisible(el)) return false;
                  const r = el.getBoundingClientRect();
                  return r.width >= 160 && r.height >= 10 && r.height <= 65;
                });
            }

            const trackRect = trackEl ? trackEl.getBoundingClientRect() : (sliderRect ? {
              left: boxRect.left + 15,
              top: sliderRect.top,
              width: boxRect.width - 30,
              height: sliderRect.height
            } : null);

            const titleEl = document.querySelector('[class*="title" i], [class*="tip" i], [class*="header" i], [class*="instruction" i], [class*="prompt" i], [class*="msg" i]');
            const questionText = titleEl ? (titleEl.innerText || titleEl.textContent || '').trim() : 'Select 2 objects with the same shape';

            const getBase64FromImg = async (imgEl) => {
              if (!imgEl) return null;
              if (imgEl.src && imgEl.src.startsWith('data:image')) {
                return imgEl.src.split(',')[1];
              }
              try {
                const canvas = document.createElement('canvas');
                canvas.width = imgEl.naturalWidth || imgEl.width || 340;
                canvas.height = imgEl.naturalHeight || imgEl.height || 340;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(imgEl, 0, 0);
                const dataUrl = canvas.toDataURL('image/png');
                if (dataUrl && dataUrl.length > 100) return dataUrl.split(',')[1];
              } catch (e) {}

              try {
                const resp = await fetch(imgEl.src);
                const blob = await resp.blob();
                return new Promise((resolve) => {
                  const reader = new FileReader();
                  reader.onloadend = () => resolve((reader.result || '').split(',')[1]);
                  reader.readAsDataURL(blob);
                });
              } catch (e) {
                return null;
              }
            };

            const allImgs = Array.from(captchaBox.querySelectorAll('img')).filter(isVisible);
            let innerBase64 = null;
            let outerBase64 = null;
            let mainImgBase64 = null;

            if (taskType === 'TiktokRotateWebTask') {
              const innerImg = allImgs.find(i => {
                const c = (i.className + ' ' + (i.id || '')).toLowerCase();
                return c.includes('inner') || c.includes('inside') || c.includes('rotat') || c.includes('circle');
              }) || allImgs[0];

              const outerImg = allImgs.find(i => {
                const c = (i.className + ' ' + (i.id || '')).toLowerCase();
                return (c.includes('outer') || c.includes('outside') || c.includes('back') || c.includes('bg')) && i !== innerImg;
              }) || (allImgs.length > 1 ? allImgs[1] : null);

              if (innerImg) innerBase64 = await getBase64FromImg(innerImg);
              if (outerImg) outerBase64 = await getBase64FromImg(outerImg);
            } else {
              const mainImg = challengeImg?.tagName === 'IMG' ? challengeImg : allImgs[0];
              if (mainImg) mainImgBase64 = await getBase64FromImg(mainImg);
            }

            return {
              found: true,
              taskType,
              question: questionText,
              innerBase64,
              outerBase64,
              mainImgBase64,
              rect: {
                x: Math.max(0, Math.round(targetRect.left)),
                y: Math.max(0, Math.round(targetRect.top)),
                width: Math.round(targetRect.width),
                height: Math.round(targetRect.height)
              },
              widthView: Math.round(targetRect.width),
              heightView: Math.round(targetRect.height),
              slider: sliderRect ? {
                x: Math.round(sliderRect.left + sliderRect.width / 2),
                y: Math.round(sliderRect.top + sliderRect.height / 2),
                width: Math.round(sliderRect.width),
                height: Math.round(sliderRect.height)
              } : null,
              track: trackRect ? {
                x: Math.round(trackRect.left),
                y: Math.round(trackRect.top),
                width: Math.round(trackRect.width),
                height: Math.round(trackRect.height)
              } : null
            };
          } catch(e) {
            return { found: false, error: String(e) };
          }
        })();
      `).catch(() => ({ found: false }));

      if (!captchaData?.found || !captchaData.rect) {
        if (attempt === 1) {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'warning',
            message: '[Captcha] ⚠️ Không tìm thấy vị trí khung ảnh CAPTCHA để chụp gửi OmoCaptcha.',
          });
        }
        return false;
      }

      let fallbackBase64 = '';
      if (!captchaData.innerBase64 && !captchaData.mainImgBase64) {
        const captureRect = {
          x: Math.max(0, Math.round(captchaData.rect.x)),
          y: Math.max(0, Math.round(captchaData.rect.y)),
          width: Math.max(20, Math.round(captchaData.rect.width)),
          height: Math.max(20, Math.round(captchaData.rect.height)),
        };
        const image = await win.webContents.capturePage(captureRect);
        fallbackBase64 = image.toDataURL().split(',')[1] || '';
      }

      const taskType = ([
        'TiktokSliderWebTask',
        'TiktokRotateWebTask',
        'TiktokSelectObjectWebTask',
        'Tiktok3DSelectObjectWebTask',
      ].includes(captchaData.taskType) ? captchaData.taskType : 'TiktokSliderWebTask') as OmoTikTokWebTaskType;

      const taskLabelMap: Record<string, string> = {
        TiktokRotateWebTask: 'Xoay khớp hình tròn (Rotate Puzzle)',
        TiktokSliderWebTask: 'Kéo thanh trượt (Slider Puzzle)',
        Tiktok3DSelectObjectWebTask: 'Khớp 2 đối tượng 3D (3D Object Match)',
        TiktokSelectObjectWebTask: 'Chọn đối tượng theo thứ tự (Select in Order)'
      };
      const taskLabel = taskLabelMap[taskType] || taskType;

      let taskPayload: any = { type: taskType };

      if (taskType === 'TiktokRotateWebTask') {
        if (captchaData.innerBase64 && captchaData.outerBase64) {
          taskPayload.imageBase64s = [captchaData.innerBase64, captchaData.outerBase64];
        } else if (captchaData.innerBase64) {
          taskPayload.imageBase64s = [captchaData.innerBase64, captchaData.innerBase64];
        } else {
          taskPayload.imageBase64s = [fallbackBase64, fallbackBase64];
        }
      } else if (taskType === 'Tiktok3DSelectObjectWebTask') {
        taskPayload.imageBase64 = captchaData.mainImgBase64 || fallbackBase64;
        taskPayload.widthView = captchaData.widthView;
        taskPayload.heightView = captchaData.heightView || captchaData.rect.height;
        taskPayload.question = captchaData.question || 'Select 2 objects with the same shape';
      } else if (taskType === 'TiktokSliderWebTask') {
        taskPayload.imageBase64 = captchaData.mainImgBase64 || fallbackBase64;
        taskPayload.widthView = captchaData.widthView;
      } else {
        taskPayload.imageBase64 = captchaData.mainImgBase64 || fallbackBase64;
        taskPayload.widthView = captchaData.widthView;
        taskPayload.heightView = captchaData.heightView || captchaData.rect.height;
      }

      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'info',
        message: `[Captcha] 📸 Đã gửi bài toán ${taskLabel} (${taskType}) lên OmoCaptcha AI...`,
      });
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'info',
        message: `[Captcha] Tọa độ CDP dùng CSS viewport px, không nhân zoom. zoom=${win.webContents.getZoomFactor() || 1}, rect=${JSON.stringify(captchaData.rect)}, slider=${JSON.stringify(captchaData.slider || null)}.`,
      });

      const createRes = await postOmoCaptcha({
        clientKey,
        task: taskPayload,
      });

      if (createRes.errorId !== 0 || !createRes.taskId) {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'error',
          message: `[Captcha] ❌ Tạo bài toán OmoCaptcha thất bại: ${createRes.errorCode || ''} - ${createRes.errorDescription || ''}`,
        });
        continue;
      }

      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'info',
        message: `[Captcha] ⏳ Đã nhận Task ID: ${createRes.taskId}, đang đợi AI giải...`,
      });

      let solution: any = null;
      for (let i = 0; i < 15; i++) {
        if (win.isDestroyed() || isSeedingCancelRequested()) return false;
        await waitForSeedingDelay(i === 0 ? 1200 : 2000, win).catch(() => {});
        if (win.isDestroyed() || isSeedingCancelRequested()) return false;

        const resultRes = await postOmoCaptcha({ clientKey, taskId: createRes.taskId });
        if (resultRes.errorId !== 0) {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'error',
            message: `[Captcha] ❌ Lỗi nhận kết quả từ OmoCaptcha: ${resultRes.errorCode || ''} ${resultRes.errorDescription || ''}`,
          });
          break;
        }
        if (resultRes.status === 'ready') {
          solution = resultRes.solution;
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: `[Captcha] 📥 OmoCaptcha đã giải xong: ${JSON.stringify(solution)}. Đang thực hiện thao tác chuột CDP...`,
          });
          break;
        }
        if (resultRes.status === 'fail') {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'warning',
            message: '[Captcha] ⚠️ OmoCaptcha báo không giải được bài toán này. Đang chuẩn bị thử lại...',
          });
          break;
        }
      }

      if (!solution) {
        continue;
      }

      const sliderWidth = captchaData.slider?.width || 40;
      const trackWidth = captchaData.track?.width || (captchaData.rect.width - 30);
      const startX = Math.round(captchaData.slider?.x || (captchaData.rect.x + sliderWidth / 2 + 10));
      const startY = Math.round(captchaData.slider?.y || (captchaData.rect.y + captchaData.rect.height - 35));
      // Exact travel length of the slider button inside the track
      const maxTravel = Math.max(40, trackWidth - sliderWidth);

      const dragByRatio = async (ratio: number) => {
        const clampedRatio = Math.max(0, Math.min(1, ratio));
        const travel = Math.round(maxTravel * clampedRatio);
        const endX = startX + travel;
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'info',
          message: `[Captcha] 🖱️ Đang kéo slider: Tỷ lệ ${(clampedRatio * 100).toFixed(1)}% (Từ ${startX}px đến ${endX}px, cự ly ${travel}px/${maxTravel}px)...`,
        });
        await performCdpDrag(win, startX, startY, endX, startY);
      };

      let applied = false;
      if (solution?.pointA && solution?.pointB) {
        await performCdpClick(win, captchaData.rect.x + Number(solution.pointA.x || 0), captchaData.rect.y + Number(solution.pointA.y || 0));
        await performCdpClick(win, captchaData.rect.x + Number(solution.pointB.x || 0), captchaData.rect.y + Number(solution.pointB.y || 0));
        applied = true;
      } else if (solution?.point1 && solution?.point2) {
        await performCdpClick(win, captchaData.rect.x + Number(solution.point1.x || 0), captchaData.rect.y + Number(solution.point1.y || 0));
        await performCdpClick(win, captchaData.rect.x + Number(solution.point2.x || 0), captchaData.rect.y + Number(solution.point2.y || 0));
        applied = true;
      } else if (Array.isArray(solution?.points) && solution.points.length > 0) {
        for (const pt of solution.points.slice(0, 6)) {
          await performCdpClick(win, captchaData.rect.x + Number(pt.x || 0), captchaData.rect.y + Number(pt.y || 0));
        }
        applied = true;
      } else if (Array.isArray(solution) && solution.length > 0 && typeof solution[0]?.x === 'number') {
        for (const pt of solution.slice(0, 6)) {
          await performCdpClick(win, captchaData.rect.x + Number(pt.x || 0), captchaData.rect.y + Number(pt.y || 0));
        }
        applied = true;
      } else if (solution?.point && typeof solution.point.x === 'number') {
        await performCdpClick(win, captchaData.rect.x + Number(solution.point.x || 0), captchaData.rect.y + Number(solution.point.y || 0));
        applied = true;
      } else if (Array.isArray(solution?.objects) && solution.objects.length > 0) {
        for (const objectIndex of solution.objects.slice(0, 6)) {
          const index = Math.max(0, Number(objectIndex) || 0);
          const col = index % 3;
          const row = Math.floor(index / 3);
          const clickX = captchaData.rect.x + (captchaData.rect.width * (col + 0.5) / 3);
          const clickY = captchaData.rect.y + (captchaData.rect.height * (row + 0.5) / 2);
          await performCdpClick(win, clickX, clickY);
        }
        applied = true;
      } else if (solution?.end && typeof solution.end.x === 'number') {
        // In Slider jigsaw puzzle, end.x is the target X position inside widthView
        const widthView = captchaData.widthView || captchaData.rect.width || 340;
        const sliderRatio = Math.max(0, Math.min(1, Number(solution.end.x) / widthView));
        await dragByRatio(sliderRatio);
        applied = true;
      } else if (typeof solution?.distance === 'number') {
        const widthView = captchaData.widthView || captchaData.rect.width || 340;
        const sliderRatio = Math.max(0, Math.min(1, solution.distance / widthView));
        await dragByRatio(sliderRatio);
        applied = true;
      } else if (typeof solution?.rotate === 'number' || typeof solution?.angle === 'number' || typeof solution?.degrees === 'number') {
        const val = Number(solution.rotate ?? solution.angle ?? solution.degrees);
        const rawRatio = Math.abs(val) <= 1 ? Math.abs(val) : (Math.abs(val) / 360);
        // In TikTok Rotate Captcha: TikTok slider drags right (clockwise), which is opposite to OmoCaptcha's counter-clockwise angle
        // Therefore, the required slider position to align is (1 - rawRatio)
        const ratio = (rawRatio > 0 && rawRatio < 1) ? (1 - rawRatio) : rawRatio;
        await dragByRatio(ratio);
        applied = true;
      } else if (typeof solution?.value === 'number' || typeof solution?.ratio === 'number' || typeof solution?.percent === 'number') {
        const val = Number(solution.value ?? solution.ratio ?? solution.percent);
        const rawRatio = Math.abs(val) <= 1 ? Math.abs(val) : (Math.abs(val) / 100);
        const ratio = (taskType === 'TiktokRotateWebTask' && rawRatio > 0 && rawRatio < 1) ? (1 - rawRatio) : rawRatio;
        await dragByRatio(ratio);
        applied = true;
      } else if (typeof solution === 'number') {
        const rawRatio = solution <= 1 ? solution : (solution / 360);
        const ratio = (taskType === 'TiktokRotateWebTask' && rawRatio > 0 && rawRatio < 1) ? (1 - rawRatio) : rawRatio;
        await dragByRatio(ratio);
        applied = true;
      }

      if (!applied) {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'warning',
          message: `[Captcha] ⚠️ Định dạng lời giải ${taskType} từ OmoCaptcha chưa được hỗ trợ: ${JSON.stringify(solution || {})}`,
        });
        continue;
      }

      await win.webContents.executeJavaScript(`
        (() => {
          try {
            const texts = ['verify', 'confirm', 'submit', 'done', 'ok', 'continue', 'xac minh', 'xong', 'tiep tuc'];
            const isVisible = (el) => {
              const r = el.getBoundingClientRect();
              const s = window.getComputedStyle(el);
              return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
            };
            const button = Array.from(document.querySelectorAll('button, [role="button"]')).find(el => {
              if (!isVisible(el)) return false;
              const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
              return texts.some(t => text.includes(t));
            });
            button?.click();
          } catch(e) {}
        })();
      `).catch(() => undefined);

      await waitForSeedingDelay(2500, win).catch(() => {});

      // Verify if Captcha modal is still visible
      const isStillPresent = await win.webContents.executeJavaScript(`
        (() => {
          try {
            const isVisible = (el) => {
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 20 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
            };
            const selectors = [
              '#captcha-verify-container',
              '.captcha-verify-container',
              '#captcha_verify_container',
              '.captcha_verify_container',
              '.sec-captcha-container',
              '.captcha-container',
              '.verify-wrap',
              '[class*="captcha-card" i]',
              '[class*="captcha-modal" i]',
              '[class*="captcha_card" i]',
              '[class*="captcha_modal" i]',
              'iframe[src*="captcha"]',
              'iframe[src*="sec"]',
              'iframe[src*="verify"]',
              'iframe[src*="challenge"]'
            ];
            return selectors.some(s => Array.from(document.querySelectorAll(s)).some(isVisible));
          } catch(e) {
            return false;
          }
        })();
      `).catch(() => false);

      if (!isStillPresent) {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'success',
          message: `[Captcha] 🎉 Đã tự động giải và vượt qua thành công CAPTCHA ${taskLabel} cho @${acc.username}! Đang đợi 4s để TikTok xác nhận phiên...`,
        });
        await waitForSeedingDelay(4000, win).catch(() => {});
        return true;
      } else {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'warning',
          message: `[Captcha] ⚠️ Thao tác lần ${attempt} chưa vượt qua được CAPTCHA, đang kiểm tra để thử lại...`,
        });
      }
    }

    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'error',
      message: `[Captcha] ❌ Không thể vượt qua CAPTCHA cho @${acc.username} sau ${maxAttempts} lần thử.`,
    });
    return false;
  } finally {
    if (originalZoomFactor !== 1 && !win.isDestroyed()) {
      win.webContents.setZoomFactor(originalZoomFactor);
    }
  }
}

export async function checkAndSolveAnyCaptcha(
  win: BrowserWindow,
  acc: { id: string; username: string },
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void
): Promise<boolean> {
  if (win.isDestroyed() || isSeedingCancelRequested()) return false;

  try {
    const hasCaptcha = await win.webContents.executeJavaScript(`
      (() => {
        try {
          const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 20 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
          };

          const specificSelectors = [
            '#captcha-verify-container',
            '.captcha-verify-container',
            '#captcha_verify_container',
            '.captcha_verify_container',
            '.sec-captcha-container',
            '.captcha-container',
            '.verify-wrap',
            '[class*="captcha-card" i]',
            '[class*="captcha-modal" i]',
            '[class*="captcha_card" i]',
            '[class*="captcha_modal" i]',
            'iframe[src*="captcha"]',
            'iframe[src*="sec"]',
            'iframe[src*="verify"]',
            'iframe[src*="challenge"]',
            '[id*="captcha" i]',
            '[class*="captcha" i]'
          ];

          const hasModalElement = specificSelectors.some(sel => {
            const els = Array.from(document.querySelectorAll(sel));
            return els.some(isVisible);
          });

          if (hasModalElement) return true;

          const bodyText = document.body?.innerText || '';
          const normalize = (s) => String(s || '').toLowerCase()
            .normalize('NFD')
            .replace(/[\\u0300-\\u036f]/g, '')
            .replace(/đ/g, 'd')
            .replace(/Đ/g, 'D')
            .trim();
          const normBody = normalize(bodyText);

          return normBody.includes('drag the slider') ||
                 normBody.includes('keo thanh truot') ||
                 normBody.includes('fit the puzzle') ||
                 normBody.includes('fit the shape') ||
                 normBody.includes('select 2 objects') ||
                 normBody.includes('chon 2 doi tuong') ||
                 normBody.includes('hai doi tuong') ||
                 normBody.includes('same shape') ||
                 normBody.includes('rotate the image') ||
                 normBody.includes('rotate') ||
                 normBody.includes('xoay hinh') ||
                 normBody.includes('xoay anh') ||
                 normBody.includes('complete the puzzle') ||
                 normBody.includes('ghep hinh') ||
                 normBody.includes('verify to continue') ||
                 normBody.includes('xac minh de tiep tuc') ||
                 normBody.includes('xac minh bao mat') ||
                 normBody.includes('security verification');
        } catch(e) {
          return false;
        }
      })();
    `).catch(() => false);

    if (hasCaptcha) {
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'info',
        message: `[Captcha] 🔍 Phát hiện CAPTCHA TikTok cho @${acc.username}, đang tiến hành giải tự động...`,
      });
      return await solveTikTokWebCaptchaWithOmo(win, acc, onLog);
    }
    return false;
  } catch (err) {
    return false;
  }
}
