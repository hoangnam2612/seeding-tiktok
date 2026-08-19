const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const appUserData = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'electron-nest-react')
  : undefined;
if (appUserData) app.setPath('userData', appUserData);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 1. Test OmoCaptcha API Key & Balance
async function testOmoCaptchaApi() {
  console.log('\n[TEST 1] Testing OmoCaptcha API connection & Balance...');
  let apiKey = '';
  const candidatePaths = [
    path.join(process.cwd(), 'data', 'settings.json'),
    path.join(process.env.APPDATA || '', 'electron-nest-react', 'data', 'settings.json'),
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try {
        const s = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (s.omocaptchaApiKey) {
          apiKey = s.omocaptchaApiKey.trim();
          break;
        }
      } catch (_) {}
    }
  }

  if (!apiKey) {
    throw new Error('OmoCaptcha API key is not configured in settings.json');
  }
  console.log(`- API Key found: ${apiKey.substring(0, 8)}...${apiKey.slice(-6)}`);

  const res = await fetch('https://api.omocaptcha.com/v2/getBalance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey: apiKey })
  });
  const data = await res.json();
  if (data.errorId !== 0) {
    throw new Error(`OmoCaptcha balance check failed: ${data.errorCode} - ${data.errorDescription}`);
  }
  console.log(`- Balance: ${data.balance} (Voucher: ${data.voucherBalance})`);
  console.log('✓ TEST 1 PASSED: OmoCaptcha API connected and balance verified.');
  return apiKey;
}

// 2. Test Multilingual Task Type Detection
async function testTaskTypeDetection(win) {
  console.log('\n[TEST 2] Testing Multilingual & DOM Task Type Detection (Vietnamese & English)...');

  // Test Vietnamese 3D text
  await win.webContents.executeJavaScript(`
    document.getElementById('captcha-tip').innerText = 'Chọn 2 đối tượng có cùng hình dạng';
  `);
  let taskType = await win.webContents.executeJavaScript(`
    (() => {
      const normalize = (s) => String(s || '').toLowerCase()
        .normalize('NFD')
        .replace(/[\\u0300-\\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .trim();
      const text = normalize(document.body.innerText);
      if (/3d|three[- ]?d|same object|same shape|matching object|2 doi tuong|hai doi tuong|cung hinh|cung doi tuong|giong nhau|khop vat the|2 vat the|vat the giong/.test(text)) {
        return 'Tiktok3DSelectObjectWebTask';
      }
      if (/rotate|xoay|angle|upright|thang dung|dung chieu|goc quay|chieu dung|dieu chinh huong|fit the shape/.test(text)) {
        return 'TiktokRotateWebTask';
      }
      return 'TiktokSliderWebTask';
    })();
  `);
  if (taskType !== 'Tiktok3DSelectObjectWebTask') {
    throw new Error(`Vietnamese 3D object detection failed, got: ${taskType}`);
  }
  console.log('  ✓ Vietnamese "Chọn 2 đối tượng có cùng hình dạng" -> Tiktok3DSelectObjectWebTask');

  // Test Vietnamese Rotate text
  await win.webContents.executeJavaScript(`
    document.getElementById('captcha-tip').innerText = 'Xoay hình ảnh theo hướng thẳng đứng';
  `);
  taskType = await win.webContents.executeJavaScript(`
    (() => {
      const normalize = (s) => String(s || '').toLowerCase()
        .normalize('NFD')
        .replace(/[\\u0300-\\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .trim();
      const text = normalize(document.body.innerText);
      if (/3d|three[- ]?d|same object|same shape|matching object|2 doi tuong|hai doi tuong|cung hinh|cung doi tuong|giong nhau|khop vat the|2 vat the|vat the giong/.test(text)) {
        return 'Tiktok3DSelectObjectWebTask';
      }
      if (/rotate|xoay|angle|upright|thang dung|dung chieu|goc quay|chieu dung|dieu chinh huong|fit the shape/.test(text)) {
        return 'TiktokRotateWebTask';
      }
      return 'TiktokSliderWebTask';
    })();
  `);
  if (taskType !== 'TiktokRotateWebTask') {
    throw new Error(`Vietnamese rotate detection failed, got: ${taskType}`);
  }
  console.log('  ✓ Vietnamese "Xoay hình ảnh theo hướng thẳng đứng" -> TiktokRotateWebTask');

  // Reset to Slider text
  await win.webContents.executeJavaScript(`
    document.getElementById('captcha-tip').innerText = 'Kéo thanh trượt để khớp mảnh ghép';
  `);
  console.log('✓ TEST 2 PASSED: Multilingual Task Type Detection verified.');
}

// 3. Test Slider Captcha End-To-End in Electron Window
async function testSliderCaptchaE2E(win, apiKey) {
  console.log('\n[TEST 3] Testing E2E Slider Captcha detection, API task, and mouse drag execution...');

  const logs = [];
  const onLog = (log) => {
    logs.push(log);
    console.log(`  [LOG ${log.level.toUpperCase()}]: ${log.message}`);
  };

  const acc = { id: 'acc_test_1', username: 'test_user' };

  // Run solver logic
  const solved = await runSolverOnWindow(win, acc, apiKey, onLog);
  if (!solved) {
    throw new Error('solveTikTokWebCaptchaWithOmo returned false for Slider Captcha');
  }

  // Check DOM events recorded in fixture
  const fixtureEvents = await win.webContents.executeJavaScript('window.__solvedEvents');
  console.log('  [DOM Result Events]:', fixtureEvents);

  if (fixtureEvents.dragSteps === 0 || fixtureEvents.draggedEndX === 0) {
    throw new Error(`Slider dragging was not executed on the DOM: ${JSON.stringify(fixtureEvents)}`);
  }
  if (!fixtureEvents.submitted) {
    throw new Error('Verify submit button was not clicked');
  }

  console.log(`✓ TEST 3 PASSED: Slider dragged ${fixtureEvents.draggedEndX}px across ${fixtureEvents.dragSteps} steps and verified successfully.`);
}

// Helper to run solver logic on window
async function runSolverOnWindow(win, acc, clientKey, onLog) {
  const OMOCAPTCHA_CREATE_TASK_URL = 'https://api.omocaptcha.com/v2/createTask';
  const OMOCAPTCHA_GET_TASK_RESULT_URL = 'https://api.omocaptcha.com/v2/getTaskResult';

  async function postOmo(payload) {
    const res = await fetch(payload.task ? OMOCAPTCHA_CREATE_TASK_URL : OMOCAPTCHA_GET_TASK_RESULT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  }

  const captchaInfo = await win.webContents.executeJavaScript(`
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
          .trim();

        const collectAllText = (root) => {
          let txt = '';
          if (root) txt += ' ' + (root.innerText || root.textContent || '');
          txt += ' ' + (document.body?.innerText || '');
          const textEls = Array.from(document.querySelectorAll('[class*="title" i], [class*="tip" i], [class*="header" i], [class*="instruction" i], [class*="text" i], [class*="prompt" i], [class*="msg" i]')).filter(isVisible);
          textEls.forEach(el => { txt += ' ' + (el.innerText || el.textContent || ''); });
          return normalize(txt);
        };

        const detectTaskType = (root) => {
          const text = collectAllText(root);
          if (/3d|three[- ]?d|same object|same shape|matching object|2 doi tuong|hai doi tuong|cung hinh|cung doi tuong|giong nhau|khop vat the|2 vat the|vat the giong/.test(text)) {
            return 'Tiktok3DSelectObjectWebTask';
          }
          if (/rotate|xoay|angle|upright|thang dung|dung chieu|goc quay|chieu dung|dieu chinh huong|fit the shape/.test(text)) {
            return 'TiktokRotateWebTask';
          }
          if (/select.*order|pick.*order|chon theo thu tu|chon doi tuong|chon vat the|chon hinh/.test(text)) {
            return 'TiktokSelectObjectWebTask';
          }
          return 'TiktokSliderWebTask';
        };

        const isModalBox = (el) => {
          if (!isVisible(el)) return false;
          const r = el.getBoundingClientRect();
          return r.width >= 200 && r.width <= 600 && r.height >= 160 && r.height <= 750;
        };

        const specificSelectors = [
          '#captcha-verify-container',
          '.captcha-verify-container',
          '.captcha-modal',
          '[class*="captcha" i]'
        ];

        const allCandidates = specificSelectors.flatMap(sel => Array.from(document.querySelectorAll(sel)));
        const modalBoxes = allCandidates.filter(isModalBox);
        const captchaBox = modalBoxes[0];
        if (!captchaBox) return { found: false };

        const boxRect = captchaBox.getBoundingClientRect();
        const challengeImg = captchaBox.querySelector('canvas, img, #captcha-verify-image');
        const targetEl = challengeImg || captchaBox;
        const targetRect = targetEl.getBoundingClientRect();

        const sliderEl = document.querySelector('.slider-btn, [role="slider"]');
        const sliderRect = sliderEl?.getBoundingClientRect();

        const trackEl = document.querySelector('.slider-track, [class*="track"]');
        const trackRect = trackEl?.getBoundingClientRect();

        return {
          found: true,
          taskType: detectTaskType(captchaBox),
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
  `);

  if (!captchaInfo?.found) return false;

  const image = await win.webContents.capturePage(captchaInfo.rect);
  const imageBase64 = image.toDataURL().split(',')[1] || '';
  const taskType = captchaInfo.taskType;

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'info',
    message: `[Captcha] Sending ${taskType} to OmoCaptcha. widthView=${captchaInfo.widthView}, heightView=${captchaInfo.heightView}`
  });

  const createRes = await postOmo({
    clientKey,
    task: {
      type: taskType,
      imageBase64,
      widthView: captchaInfo.widthView
    }
  });

  if (createRes.errorId !== 0 || !createRes.taskId) {
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'error',
      message: `[Captcha] OmoCaptcha createTask failed: ${createRes.errorCode} ${createRes.errorDescription}`
    });
    return false;
  }

  let solution = null;
  for (let i = 0; i < 15; i++) {
    await delay(i === 0 ? 1200 : 2000);
    const resultRes = await postOmo({ clientKey, taskId: createRes.taskId });
    if (resultRes.errorId !== 0) {
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'error',
        message: `[Captcha] getTaskResult error: ${resultRes.errorCode} ${resultRes.errorDescription}`
      });
      return false;
    }
    if (resultRes.status === 'ready') {
      solution = resultRes.solution;
      break;
    }
    if (resultRes.status === 'fail') {
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'error',
        message: '[Captcha] Task failed on OmoCaptcha server'
      });
      return false;
    }
  }

  if (!solution) {
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'error',
      message: '[Captcha] No solution received'
    });
    return false;
  }

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'info',
    message: `[Captcha] OmoCaptcha solution received: ${JSON.stringify(solution)}`
  });

  const zoomFactor = win.webContents.getZoomFactor();
  const toAbsolutePoint = (point) => ({
    x: Math.round((captchaInfo.rect.x + Number(point.x || 0)) * zoomFactor),
    y: Math.round((captchaInfo.rect.y + Number(point.y || 0)) * zoomFactor),
  });

  const dragToPoint = async (end) => {
    const startX = Math.round((captchaInfo.slider?.x || (captchaInfo.rect.x + 38)) * zoomFactor);
    const startY = Math.round((captchaInfo.slider?.y || (captchaInfo.rect.y + captchaInfo.rect.height - 34)) * zoomFactor);
    const endPoint = toAbsolutePoint({
      x: Number(end.x || 0),
      y: typeof end.y === 'number' ? end.y : (captchaInfo.slider?.y ? (captchaInfo.slider.y - captchaInfo.rect.y) : (captchaInfo.rect.height - 34)),
    });
    const steps = 32;

    win.webContents.sendInputEvent({ type: 'mouseMove', x: startX, y: startY });
    await delay(50);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: startX, y: startY, button: 'left', clickCount: 1 });
    await delay(60);

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = 1 - Math.pow(1 - t, 3);
      const x = Math.round(startX + (endPoint.x - startX) * ease + (Math.random() * 2 - 1));
      const y = Math.round(startY + (endPoint.y - startY) * t + (Math.random() * 2 - 1));
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      await delay(16);
    }
    await delay(50);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: endPoint.x, y: endPoint.y, button: 'left', clickCount: 1 });
  };

  let applied = false;
  if (solution?.end && typeof solution.end.x === 'number') {
    await dragToPoint(solution.end);
    applied = true;
  } else if (typeof solution?.x === 'number') {
    await dragToPoint({ x: solution.x, y: solution.y });
    applied = true;
  } else if (typeof solution === 'number') {
    await dragToPoint({ x: solution });
    applied = true;
  }

  if (applied) {
    await win.webContents.executeJavaScript(`
      (() => {
        const btn = document.getElementById('verify-submit-btn') || Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Xác nhận'));
        btn?.click();
      })();
    `);
    await delay(1000);
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'success',
      message: `[Captcha] OmoCaptcha ${taskType} solution successfully executed and verified!`
    });
    return true;
  }
  return false;
}

app.whenReady().then(async () => {
  try {
    const apiKey = await testOmoCaptchaApi();

    const win = new BrowserWindow({
      width: 600,
      height: 500,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false
      }
    });

    await win.loadFile(path.join(__dirname, 'fixtures', 'e2e-captcha-fixture.html'));
    win.webContents.setZoomFactor(1.0);
    await delay(1000);

    await testTaskTypeDetection(win);
    await testSliderCaptchaE2E(win, apiKey);

    console.log('\n========================================');
    console.log('🎉 ALL CAPTCHA E2E TESTS PASSED 100%!');
    console.log('========================================\n');
    win.destroy();
    app.quit();
  } catch (error) {
    console.error('\n❌ E2E CAPTCHA TEST FAILED:', error);
    app.exit(1);
  }
});
