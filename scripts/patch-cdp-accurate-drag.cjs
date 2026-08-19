const fs = require('fs');
const path = require('path');

const runnerPath = path.join(__dirname, '..', 'src', 'main', 'automation-runner.ts');
let content = fs.readFileSync(runnerPath, 'utf8');

const oldSolveFuncRegex = /async function solveTikTokWebCaptchaWithOmo\([\s\S]*?async function checkAndSolveAnyCaptcha/;

const newSolveFuncCode = `async function performCdpDrag(
  win: BrowserWindow,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  steps = 35
) {
  let needDetach = false;
  if (!win.webContents.debugger.isAttached()) {
    try {
      win.webContents.debugger.attach('1.3');
      needDetach = true;
    } catch {}
  }

  try {
    // 1. Move cursor to slider center
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startX,
      y: startY,
    });
    await new Promise(r => setTimeout(r, 60));

    // 2. Mouse Press
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: startX,
      y: startY,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await new Promise(r => setTimeout(r, 80));

    // 3. Humanized curve movement
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = 1 - Math.pow(1 - t, 3);
      const curX = Math.round(startX + (endX - startX) * ease + (Math.random() * 2 - 1));
      const curY = Math.round(startY + (endY - startY) * t + (Math.random() * 2 - 1));
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: curX,
        y: curY,
        button: 'left',
        buttons: 1,
      });
      await new Promise(r => setTimeout(r, 14 + Math.random() * 16));
    }

    await new Promise(r => setTimeout(r, 80));

    // 4. Mouse Release
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: endX,
      y: endY,
      button: 'left',
      buttons: 0,
    });
  } catch (err) {
    // Fallback to sendInputEvent if CDP fails
    try {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: startX, y: startY });
      win.webContents.sendInputEvent({ type: 'mouseDown', x: startX, y: startY, button: 'left', clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        const curX = Math.round(startX + (endX - startX) * (i / steps));
        win.webContents.sendInputEvent({ type: 'mouseMove', x: curX, y: startY });
        await new Promise(r => setTimeout(r, 15));
      }
      win.webContents.sendInputEvent({ type: 'mouseUp', x: endX, y: endY, button: 'left', clickCount: 1 });
    } catch {}
  }
}

async function performCdpClick(win: BrowserWindow, x: number, y: number) {
  let needDetach = false;
  if (!win.webContents.debugger.isAttached()) {
    try {
      win.webContents.debugger.attach('1.3');
      needDetach = true;
    } catch {}
  }

  try {
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    });
    await new Promise(r => setTimeout(r, 60));

    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await new Promise(r => setTimeout(r, 80));

    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
    });
    await new Promise(r => setTimeout(r, 300));
  } catch {
    try {
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    } catch {}
  }
}

async function solveTikTokWebCaptchaWithOmo(
  win: BrowserWindow,
  acc: { id: string; username: string },
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void
): Promise<boolean> {
  if (win.isDestroyed() || isSeedingCancelRequested()) return false;

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
        message: \`[Captcha] 🔄 Thử giải lại CAPTCHA (Lần \${attempt}/\${maxAttempts}) cho @\${acc.username}...\`,
      });
      await waitForSeedingDelay(1500, win);
    }

    const captchaData = await win.webContents.executeJavaScript(\`
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
            .replace(/[\\\\u0300-\\\\u036f]/g, '')
            .replace(/đ/g, 'd')
            .replace(/Đ/g, 'D')
            .trim();

          const collectAllText = (root) => {
            let txt = '';
            if (root) txt += ' ' + (root.innerText || root.textContent || '');
            txt += ' ' + (document.body?.innerText || '');
            const textEls = Array.from(document.querySelectorAll('[class*="title" i], [class*="tip" i], [class*="header" i], [class*="instruction" i], [class*="text" i], [class*="prompt" i], [class*="msg" i]')).filter(isVisible);
            textEls.forEach(el => { txt += ' ' + (el.innerText || el.textContent || ''); });
            const iframes = Array.from(document.querySelectorAll('iframe')).filter(isVisible);
            iframes.forEach(f => {
              txt += ' ' + (f.title || f.getAttribute('aria-label') || f.src || '');
            });
            return normalize(txt);
          };

          const isModalBox = (el) => {
            if (!isVisible(el)) return false;
            const r = el.getBoundingClientRect();
            return r.width >= 180 && r.width <= 650 && r.height >= 140 && r.height <= 800;
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
          const modalBoxes = allCandidates.filter(isModalBox);

          let captchaBox = modalBoxes[0];
          if (!captchaBox) {
            const largeCandidates = allCandidates.filter(isVisible).filter(el => {
              const r = el.getBoundingClientRect();
              return r.width > 180 && r.height > 140;
            });
            for (const parent of largeCandidates) {
              const inner = Array.from(parent.querySelectorAll('div, iframe, form, section')).find(isModalBox);
              if (inner) {
                captchaBox = inner;
                break;
              }
            }
          }

          if (!captchaBox) {
            captchaBox = Array.from(document.querySelectorAll('iframe')).find(isVisible);
          }

          if (!captchaBox) return { found: false };

          const detectTaskType = (root) => {
            const text = collectAllText(root);
            if (/3d|three[- ]?d|same object|same shape|matching object|2 doi tuong|hai doi tuong|cung hinh|cung doi tuong|giong nhau|khop vat the|2 vat the|vat the giong/.test(text)) {
              return 'Tiktok3DSelectObjectWebTask';
            }
            const hasRotateKeyword = /rotate|xoay|angle|upright|thang dung|dung chieu|goc quay|chieu dung|dieu chinh huong|fit the shape|fit the puzzle|khop hinh|khop manh|ghep hinh/.test(text);
            const hasCircleOrRotateEl = !!document.querySelector(
              '[class*="circle" i], [class*="round" i], [class*="rotate" i], img[class*="inner" i], img[class*="outer" i], div[style*="50%"], div[style*="100%"], [id*="rotate" i]'
            );
            if (hasRotateKeyword || hasCircleOrRotateEl || text.includes('fit the puzzle')) {
              return 'TiktokRotateWebTask';
            }
            if (/select.*order|pick.*order|chon theo thu tu|chon doi tuong|chon vat the|chon hinh/.test(text)) {
              return 'TiktokSelectObjectWebTask';
            }
            if (/select|choose|pick|chon/.test(text) && /object|vat the|hinh|doi tuong/.test(text)) {
              return 'TiktokSelectObjectWebTask';
            }
            return 'TiktokSliderWebTask';
          };

          const taskType = detectTaskType(captchaBox);
          const boxRect = captchaBox.getBoundingClientRect();

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

          const sliderCandidates = Array.from(document.querySelectorAll(
            '[class*="slider-btn" i], [class*="sec-slider" i], [class*="drag-btn" i], [class*="slider" i], [class*="drag" i], [class*="handle" i], [role="slider"], button, div[class*="button" i], div[class*="btn" i], div[class*="thumb" i], div[class*="arrow" i]'
          )).filter(el => {
            if (!isVisible(el)) return false;
            const r = el.getBoundingClientRect();
            return r.width >= 16 && r.height >= 16 && r.left >= boxRect.left - 40 && r.right <= boxRect.right + 40 && r.top >= boxRect.top - 20 && r.bottom <= boxRect.bottom + 80;
          }).sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return ar.left - br.left;
          });
          const sliderEl = sliderCandidates[0];
          const sliderRect = sliderEl?.getBoundingClientRect();

          const trackCandidates = Array.from(document.querySelectorAll(
            '[class*="slider-track" i], [class*="track" i], [class*="slider-bg" i], [class*="drag-bar" i], [class*="slide_bar" i], [class*="slider" i], [class*="drag" i], [class*="bar" i], [class*="rail" i]'
          )).filter(el => {
            if (!isVisible(el)) return false;
            const r = el.getBoundingClientRect();
            return r.width >= 80 && r.height >= 6 && r.left >= boxRect.left - 40 && r.right <= boxRect.right + 40 && r.top >= boxRect.top - 20 && r.bottom <= boxRect.bottom + 80;
          }).sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return (br.width * br.height) - (ar.width * ar.height);
          });
          const trackEl = trackCandidates[0];
          const trackRect = trackEl?.getBoundingClientRect();

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
    \`).catch(() => ({ found: false }));

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

    const zoomFactor = win.webContents.getZoomFactor() || 1;
    let fallbackBase64 = '';
    if (!captchaData.innerBase64 && !captchaData.mainImgBase64) {
      const captureRect = {
        x: Math.max(0, Math.round(captchaData.rect.x * zoomFactor)),
        y: Math.max(0, Math.round(captchaData.rect.y * zoomFactor)),
        width: Math.max(20, Math.round(captchaData.rect.width * zoomFactor)),
        height: Math.max(20, Math.round(captchaData.rect.height * zoomFactor)),
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
      message: \`[Captcha] 📸 Đã gửi bài toán \${taskLabel} (\${taskType}) lên OmoCaptcha AI...\`,
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
        message: \`[Captcha] ❌ Tạo bài toán OmoCaptcha thất bại: \${createRes.errorCode || ''} - \${createRes.errorDescription || ''}\`,
      });
      continue;
    }

    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'info',
      message: \`[Captcha] ⏳ Đã nhận Task ID: \${createRes.taskId}, đang đợi AI giải...\`,
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
          message: \`[Captcha] ❌ Lỗi nhận kết quả từ OmoCaptcha: \${resultRes.errorCode || ''} \${resultRes.errorDescription || ''}\`,
        });
        break;
      }
      if (resultRes.status === 'ready') {
        solution = resultRes.solution;
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'info',
          message: \`[Captcha] 📥 OmoCaptcha đã giải xong: \${JSON.stringify(solution)}. Đang thực hiện thao tác chuột CDP...\`,
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

    const startX = Math.round(captchaData.slider?.x || (captchaData.rect.x + 38));
    const startY = Math.round(captchaData.slider?.y || (captchaData.rect.y + captchaData.rect.height - 34));
    const trackWidth = captchaData.track?.width || Math.max(120, captchaData.rect.width - 70);
    const sliderWidth = captchaData.slider?.width || 36;
    const maxTravel = Math.max(40, trackWidth - sliderWidth);

    const dragByRatio = async (ratio: number) => {
      const travel = Math.round(maxTravel * Math.max(0, Math.min(1, ratio)));
      const endX = startX + travel;
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
      const endX = captchaData.rect.x + Number(solution.end.x);
      await performCdpDrag(win, startX, startY, endX, startY);
      applied = true;
    } else if (typeof solution?.distance === 'number') {
      await performCdpDrag(win, startX, startY, startX + solution.distance, startY);
      applied = true;
    } else if (typeof solution?.rotate === 'number' || typeof solution?.angle === 'number' || typeof solution?.degrees === 'number') {
      const val = Number(solution.rotate ?? solution.angle ?? solution.degrees);
      const ratio = Math.abs(val) <= 1 ? Math.abs(val) : (Math.abs(val) / 360);
      await dragByRatio(ratio);
      applied = true;
    } else if (typeof solution?.value === 'number' || typeof solution?.ratio === 'number' || typeof solution?.percent === 'number') {
      const val = Number(solution.value ?? solution.ratio ?? solution.percent);
      const ratio = Math.abs(val) <= 1 ? Math.abs(val) : (Math.abs(val) / 100);
      await dragByRatio(ratio);
      applied = true;
    } else if (typeof solution === 'number') {
      const ratio = solution <= 1 ? solution : (solution / 360);
      await dragByRatio(ratio);
      applied = true;
    }

    if (!applied) {
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'warning',
        message: \`[Captcha] ⚠️ Định dạng lời giải \${taskType} từ OmoCaptcha chưa được hỗ trợ: \${JSON.stringify(solution || {})}\`,
      });
      continue;
    }

    await win.webContents.executeJavaScript(\`
      (() => {
        try {
          const texts = ['verify', 'confirm', 'submit', 'done', 'ok', 'continue', 'xac minh', 'xong', 'tiep tuc'];
          const isVisible = (el) => {
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && style.display !== 'none';
          };
          const button = Array.from(document.querySelectorAll('button, [role="button"]')).find(el => {
            if (!isVisible(el)) return false;
            const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
            return texts.some(t => text.includes(t));
          });
          button?.click();
        } catch(e) {}
      })();
    \`).catch(() => undefined);

    await waitForSeedingDelay(2500, win).catch(() => {});

    // Verify if Captcha modal is still visible
    const isStillPresent = await win.webContents.executeJavaScript(\`
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
    \`).catch(() => false);

    if (!isStillPresent) {
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'success',
        message: \`[Captcha] 🎉 Đã tự động giải và vượt qua thành công CAPTCHA \${taskLabel} cho @\${acc.username}! Đang đợi 4s để TikTok xác nhận phiên...\`,
      });
      await waitForSeedingDelay(4000, win).catch(() => {});
      return true;
    } else {
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'warning',
        message: \`[Captcha] ⚠️ Thao tác lần \${attempt} chưa vượt qua được CAPTCHA, đang kiểm tra để thử lại...\`,
      });
    }
  }

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'error',
    message: \`[Captcha] ❌ Không thể vượt qua CAPTCHA cho @\${acc.username} sau \${maxAttempts} lần thử.\`,
  });
  return false;
}

async function checkAndSolveAnyCaptcha`;

content = content.replace(oldSolveFuncRegex, newSolveFuncCode);
fs.writeFileSync(runnerPath, content, 'utf8');
console.log('Successfully patched CDP accurate drag in automation-runner.ts!');
