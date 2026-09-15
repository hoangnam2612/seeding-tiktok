const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve(__dirname, '../tmp/feature-ui');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'session'));
app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1180, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error('Renderer:', message); });
  try {
    await win.webContents.session.clearStorageData();
    await win.loadFile(path.join(output, 'index.html'));
    await sleep(500);
    const js = code => win.webContents.executeJavaScript(code).catch(error => { throw new Error(code + ': ' + error.message); });
    const clickText = text => js(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes(${JSON.stringify(text)})).click()`);
    assert.ok((await js('document.body.innerText')).includes('Tài khoản kiểm thử'));
    await clickText('Thêm video'); await sleep(100);
    assert.ok((await js('document.body.innerText')).includes('Sản phẩm mùa thu'));
    await js(`document.querySelector('input[aria-label="Chọn demo_account"]').click()`);
    await sleep(100);
    await clickText('Bắt đầu'); await sleep(100);
    const start = await js(`window.fixtureCalls.find(c => c.action === 'start')`);
    assert.equal(start.payload.command, 'upload');
    assert.deepEqual(start.payload.accountIds, ['fixture']);
    assert.equal(start.payload.config.videos[0].path, 'C:\\fixtures\\video.mp4');
    await clickText('Dừng lại'); await sleep(1100);
    assert.ok(await js(`window.fixtureCalls.some(c => c.action === 'cancel')`));
    for (const tab of ['upload', 'profile', 'video-live', 'tools', 'browser-settings']) {
      await js(`window.showFeature(${JSON.stringify(tab)})`); await sleep(100);
      for (const theme of ['dark', 'light']) {
        await js(`document.documentElement.setAttribute('data-theme', '${theme}')`);
        await sleep(350);
        assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 2'), tab + ' must not overflow horizontally');
        if (['video-live', 'upload', 'profile'].includes(tab)) {
          assert.ok(await js(`(() => { const w = document.querySelector('.seeding-workspace'); return w.parentElement.scrollHeight <= w.parentElement.clientHeight + 1 && w.scrollHeight <= w.clientHeight + 1; })()`), tab + ' must not scroll outside the panels');
        }
        const png = await win.webContents.capturePage();
        fs.writeFileSync(path.join(output, `${tab}-${theme}.png`), png.toPNG());
      }
    }
    await js(`window.showFeature('video-live')`); await sleep(100);
    await clickText('Livestream'); await sleep(100);
    assert.ok((await js('document.body.innerText')).includes('Số tim mỗi vòng'));
    await js(`window.showFeature('profile')`); await sleep(100);
    assert.ok((await js('document.body.innerText')).includes('Không dùng lại nội dung'));
    await js('window.showAuth()'); await sleep(600);
    assert.ok((await js('document.body.innerText')).includes('Nhớ mật khẩu trên máy này'));
    await clickText('Quên mật khẩu'); await sleep(200);
    assert.ok((await js('document.body.innerText')).includes('Đổi mật khẩu'));
    assert.equal(await js("document.querySelector('form').innerText.includes('Username')"), false);
    fs.writeFileSync(path.join(output, 'reset-password.png'), (await win.webContents.capturePage()).toPNG());
    console.log('PASS: five feature screens, dark/light layout, account selection, upload payload, cancellation, live/profile controls. Screenshots: ' + output);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: true, checks: ['five screens', 'dark/light', 'selection', 'upload', 'cancel', 'live', 'profile', 'remember login', 'reset password screen'] }));
    app.exit(0);
  } catch (error) { fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: false, message: error.message })); console.error(error); app.exit(1); }
});

