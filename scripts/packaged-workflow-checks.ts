export {};
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '../..');
const bundle = path.join(root, 'release/win-unpacked/resources/app.asar');
const output = path.join(root, 'tmp/packaged-workflows'); fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'session')); app.disableHardwareAcceleration();
process.chdir(output);
app.whenReady().then(async () => {
  let win: any, browser: any;
  try {
    const resource = (relative: string) => require(path.join(bundle, relative));
    const { safeStorage } = require('electron');
    assert.equal(safeStorage.isEncryptionAvailable(), true);
    assert.equal(safeStorage.decryptString(safeStorage.encryptString('fixture')), 'fixture');
    const { setupWorkflowIPC } = resource('dist/main/workflows/ipc.js');
    const account = { id: 'fixture', username: 'fixture', status: 'unauthenticated' };
    setupWorkflowIPC({ getAccountById: () => account }, { addLog: () => {} }, { ensureLicensed: async () => ({ ok: false, message: 'fixture-denied' }) }, () => win);
    win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(bundle, 'dist/preload/index.js'), contextIsolation: true, nodeIntegration: false } });
    const html = path.join(output, 'fixture.html'); fs.writeFileSync(html, '<!doctype html><title>Workflow IPC fixture</title>');
    await win.loadFile(html);
    const state = await win.webContents.executeJavaScript("window.electronAPI.workflows('state')");
    assert.equal(state.available, true); assert.equal(state.isRunning, false);
    assert.equal(await win.webContents.executeJavaScript("window.electronAPI.workflows('start', { command: 'login', accountIds: ['fixture'] }).then(() => false, e => e.message.includes('fixture-denied'))"), true);
    const { chromium } = resource('node_modules/playwright-core');
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage(); await page.setContent('<button>Fixture</button>'); assert.equal(await page.locator('button').innerText(), 'Fixture');
    const { exportAccounts } = resource('dist/main/workflows/account-transfer.js');
    const file = path.join(output, 'accounts.xlsx'); await exportAccounts(file, [account], 'UID', true, () => ''); assert.ok(fs.statSync(file).size > 1000);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: true, checks: ['packaged preload IPC', 'license gate', 'bundled Playwright Chrome launch', 'bundled Excel export', 'OS encryption'] }, null, 2));
    console.log('PASS packaged workflow runtime, IPC, Chrome, Excel, OS encryption');
    await browser.close(); win.destroy(); app.exit(0);
  } catch (error) { console.error(error); await browser?.close().catch(() => {}); win?.destroy(); app.exit(1); }
});
