const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');

const OMOCAPTCHA_CREATE_TASK_URL = 'https://api.omocaptcha.com/v2/createTask';
const OMOCAPTCHA_GET_TASK_RESULT_URL = 'https://api.omocaptcha.com/v2/getTaskResult';
const TARGET_URL = 'https://www.tiktok.com/@al0nelyy/video/7673543016979696928?is_from_webapp=1&sender_device=pc';

function getOmoCaptchaApiKey() {
  const candidatePaths = [
    path.join(process.env.APPDATA || '', 'electron-nest-react', 'data', 'settings.json'),
    path.join(process.env.APPDATA || '', 'Seeding TikTok', 'data', 'settings.json'),
    path.join(process.cwd(), 'data', 'settings.json'),
  ];
  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (parsed.omocaptchaApiKey) return String(parsed.omocaptchaApiKey).trim();
      }
    } catch {}
  }
  return 'OMO_K6HK5MYXHNNL40SGFNED313GBDGSI3HNIHIDHFHGT30GLJYXYIEJIZC5BBY12P1778741607';
}

function getAccounts() {
  const p = path.join(process.cwd(), 'data', 'accounts.json');
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }
  return [];
}

async function performCdpDrag(win, startX, startY, endX, endY, steps = 30) {
  if (!win.webContents.debugger.isAttached()) {
    try { win.webContents.debugger.attach('1.3'); } catch {}
  }

  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: startX, y: startY
  }).catch(() => {});
  await new Promise(r => setTimeout(r, 40));

  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1
  }).catch(() => {});
  await new Promise(r => setTimeout(r, 60));

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = 1 - Math.pow(1 - t, 3);
    const curX = Math.round(startX + (endX - startX) * ease);
    const curY = Math.round(startY + (endY - startY) * t);
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: curX, y: curY, button: 'left', buttons: 1
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 15));
  }

  await new Promise(r => setTimeout(r, 60));
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: endX, y: endY, button: 'left', buttons: 0
  }).catch(() => {});
}

async function solveCaptchaIfPresent(win, acc) {
  const clientKey = getOmoCaptchaApiKey();
  const captchaData = await win.webContents.executeJavaScript(`
    (async () => {
      try {
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 20 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none';
        };

        const modal = document.querySelector('#captcha-verify-container, .captcha-verify-container, #captcha_verify_container, .sec-captcha-container, .captcha-container, .verify-wrap, [class*="captcha-card" i], [class*="captcha-modal" i]');
        if (!modal || !isVisible(modal)) return { found: false };

        const boxRect = modal.getBoundingClientRect();

        const specificSliderSelectors = [
          '.captcha_verify_slide--slidebtn',
          '.sec-captcha-slider-btn',
          '[class*="slidebtn" i]',
          '[class*="slider-btn" i]',
          '[class*="drag-btn" i]',
          '[role="slider"]'
        ];
        let sliderEl = specificSliderSelectors.flatMap(sel => Array.from(modal.querySelectorAll(sel))).find(isVisible);
        if (!sliderEl) {
          const fallbackSliders = Array.from(modal.querySelectorAll('div, span, button')).filter(el => {
            if (!isVisible(el)) return false;
            const r = el.getBoundingClientRect();
            return r.width >= 24 && r.width <= 65 && r.height >= 24 && r.height <= 65 && r.top >= boxRect.bottom - 120;
          });
          sliderEl = fallbackSliders[0];
        }

        const sliderRect = sliderEl ? sliderEl.getBoundingClientRect() : null;

        let trackEl = null;
        if (sliderEl) {
          let parent = sliderEl.parentElement;
          while (parent && parent !== modal && parent !== document.body) {
            const pr = parent.getBoundingClientRect();
            if (pr.width >= 160 && pr.height >= 20 && pr.height <= 65) {
              trackEl = parent;
              break;
            }
            parent = parent.parentElement;
          }
        }
        const trackRect = trackEl ? trackEl.getBoundingClientRect() : (sliderRect ? { width: boxRect.width - 30 } : null);

        const allImgs = Array.from(modal.querySelectorAll('img')).filter(isVisible);
        const getBase64 = async (imgEl) => {
          if (!imgEl) return null;
          if (imgEl.src && imgEl.src.startsWith('data:image')) return imgEl.src.split(',')[1];
          try {
            const canvas = document.createElement('canvas');
            canvas.width = imgEl.naturalWidth || imgEl.width || 340;
            canvas.height = imgEl.naturalHeight || imgEl.height || 340;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(imgEl, 0, 0);
            return canvas.toDataURL('image/png').split(',')[1];
          } catch(e) { return null; }
        };

        const innerImg = allImgs.find(i => (i.className + ' ' + (i.id || '')).toLowerCase().includes('inner')) || allImgs[0];
        const outerImg = allImgs.find(i => (i.className + ' ' + (i.id || '')).toLowerCase().includes('outer')) || allImgs[1];

        const innerBase64 = await getBase64(innerImg);
        const outerBase64 = await getBase64(outerImg);

        return {
          found: true,
          hasSlider: !!sliderEl,
          innerBase64,
          outerBase64,
          slider: sliderRect ? { x: Math.round(sliderRect.left + sliderRect.width/2), y: Math.round(sliderRect.top + sliderRect.height/2), width: Math.round(sliderRect.width) } : null,
          track: trackRect ? { width: Math.round(trackRect.width) } : null
        };
      } catch(e) { return { found: false, error: String(e) }; }
    })()
  `);

  if (!captchaData.found) return false;

  console.log(`[@${acc.username}] 🔍 Phát hiện CAPTCHA trên màn hình! Đang xử lý...`);
  console.log(`[@${acc.username}] Slider data:`, JSON.stringify(captchaData.slider), 'Track data:', JSON.stringify(captchaData.track));

  if (captchaData.hasSlider && captchaData.innerBase64 && captchaData.outerBase64) {
    console.log(`[@${acc.username}] 📸 Gửi TiktokRotateWebTask lên OmoCaptcha...`);
    const createRes = await fetch(OMOCAPTCHA_CREATE_TASK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey,
        task: {
          type: 'TiktokRotateWebTask',
          imageBase64s: [captchaData.innerBase64, captchaData.outerBase64]
        }
      })
    }).then(r => r.json());

    if (createRes.errorId !== 0 || !createRes.taskId) {
      console.log(`[@${acc.username}] ❌ Lỗi tạo task OmoCaptcha:`, createRes);
      return false;
    }

    console.log(`[@${acc.username}] ⏳ Đã gửi task (Task ID: ${createRes.taskId}), đang đợi AI giải...`);

    let solution = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const res = await fetch(OMOCAPTCHA_GET_TASK_RESULT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey, taskId: createRes.taskId })
      }).then(r => r.json());

      if (res.status === 'ready') {
        solution = res.solution;
        console.log(`[@${acc.username}] 📥 OmoCaptcha giải xong sau ${(i * 2 + 2)}s:`, solution);
        break;
      }
    }

    if (solution) {
      const ratio = typeof solution.rotate === 'number' ? solution.rotate : (Number(solution) || 0.3);
      const startX = captchaData.slider.x;
      const startY = captchaData.slider.y;
      const trackWidth = captchaData.track?.width || 260;
      const sliderWidth = captchaData.slider?.width || 40;
      const maxTravel = Math.max(40, trackWidth - sliderWidth);
      const travel = Math.round(maxTravel * ratio);
      const endX = startX + travel;

      console.log(`[@${acc.username}] 🖱️ Đang thực hiện kéo chuột CDP: Tỷ lệ ${(ratio * 100).toFixed(1)}% (${startX}px -> ${endX}px, cự ly ${travel}px)...`);
      await performCdpDrag(win, startX, startY, endX, startY, 30);
      await new Promise(r => setTimeout(r, 3000));
      console.log(`[@${acc.username}] 🎉 Hoàn tất giải CAPTCHA!`);
      return true;
    }
  }

  return false;
}

async function runSingleAccount(acc, index, total) {
  console.log(`\n------------------------------------------------------`);
  console.log(`[Account ${index + 1}/${total}] 🚀 Bắt đầu chạy tài khoản: @${acc.username}`);
  console.log(`------------------------------------------------------`);

  const win = new BrowserWindow({
    width: 480,
    height: 380,
    show: true,
    title: `[${index + 1}/${total}] @${acc.username}`,
    webPreferences: {
      session: session.fromPartition(`persist:test_acc_${acc.id}`),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    }
  });

  win.webContents.setZoomFactor(0.52);

  try {
    console.log(`[@${acc.username}] Đang mở video TikTok: ${TARGET_URL}...`);
    await win.loadURL(TARGET_URL).catch(() => {});
    await new Promise(r => setTimeout(r, 4500));

    // Check & solve initial captcha if present
    await solveCaptchaIfPresent(win, acc);

    // Simulate Like Action
    const likeResult = await win.webContents.executeJavaScript(`
      (() => {
        const likeBtn = document.querySelector('[data-e2e="like-icon"], [data-e2e="browse-like-icon"], button[aria-label*="like" i]');
        if (likeBtn) {
          likeBtn.click();
          return true;
        }
        return false;
      })()
    `).catch(() => false);
    console.log(`[@${acc.username}] Like action result: ${likeResult ? 'Clicked' : 'Skipped/Liked'}`);

    await new Promise(r => setTimeout(r, 1500));
    await solveCaptchaIfPresent(win, acc);

    console.log(`[@${acc.username}] ✅ Hoàn thành tác vụ cho @${acc.username}!`);
    return { success: true, username: acc.username };
  } finally {
    if (!win.isDestroyed()) {
      win.close();
    }
  }
}

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.whenReady().then(async () => {
  const accounts = getAccounts();
  console.log('\n======================================================');
  console.log(`🚀 BẮT ĐẦU TEST E2E TRÊN TOÀN BỘ ${accounts.length} TÀI KHOẢN`);
  console.log('Target URL:', TARGET_URL);
  console.log('======================================================\n');

  const maxConcurrent = 3;
  const results = [];

  for (let i = 0; i < accounts.length; i += maxConcurrent) {
    const chunk = accounts.slice(i, i + maxConcurrent);
    console.log(`\n📦 Đang chạy Batch ${Math.floor(i / maxConcurrent) + 1} (${chunk.length} tài khoản song song)...`);
    const chunkResults = await Promise.all(chunk.map((acc, idx) => runSingleAccount(acc, i + idx, accounts.length)));
    results.push(...chunkResults);
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('\n======================================================');
  console.log(`🎉 HOÀN THÀNH TEST TOÀN BỘ ${results.length}/${accounts.length} TÀI KHOẢN!`);
  console.log(`Thành công: ${results.filter(r => r.success).length}/${accounts.length}`);
  console.log('======================================================\n');

  app.quit();
});
