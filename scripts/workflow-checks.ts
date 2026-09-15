export {};
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const Module = require('node:module'), originalLoad = Module._load;
const handlers: Record<string, any> = {};
Module._load = function (id: string, ...args: any[]) {
  if (id === '../data-dir') return { ensurePersistentDataDir: () => output };
  if (id === 'electron') return { safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }, screen: {}, app: { on: () => {} }, ipcMain: { handle: (name: string, handler: any) => { handlers[name] = handler; } } };
  return originalLoad.call(this, id, ...args);
};
const output = path.resolve('tmp/workflow-tests/data'); fs.mkdirSync(output, { recursive: true });
const source = (name: string) => require(path.resolve('dist/main/workflows', name));
const v = source('validation'), { defaults } = source('contracts');
const { parseAccounts, formatAccounts, exportAccounts } = source('account-transfer');
const { parseProxy, parseCookies } = source('browser');
const { extractMailCode, trustedMicrosoftUrl, OutlookService } = source('outlook');
const { loginIdentifier, isEmailChallenge, authenticated } = source('login');
const { pooled, delay } = source('control');
const { uploadVideo } = source('upload'), { updateProfile } = source('profile');
const { seedVideo, sendComment } = source('seeding');
const { chromium } = require('playwright-core');
const signal = new AbortController().signal, checks: string[] = [];
async function test(name: string, run: () => any) { await run(); checks.push(name); console.log('PASS', name); }
async function main() {
  await test('configuration, exact URL trust and product pairing', () => {
    assert.equal(v.isTikTokUrl('https://vm.tiktok.com/a'), true);
    for (const url of ['http://tiktok.com', 'https://tiktok.com.evil.test', 'https://a@tiktok.com', 'https://tiktok.com:444']) assert.equal(v.isTikTokUrl(url), false);
    assert.throws(() => v.validateBrowser({ maxThreads: 0 }));
    assert.throws(() => v.validateConfig('video', { videoUrls: ['https://tiktok.com'], minViewSeconds: 9, maxViewSeconds: 2 }, 1));
    assert.throws(() => v.validateConfig('profile', { isChangeName: true, names: ['A'], avoidDuplicateContent: true }, 2));
    const products = v.parseProducts(['001|First', '001|Second']);
    const config = { ...defaults.upload, attachProducts: true, products, videos: [{ path: 'a' }, { path: 'b' }] };
    const queue = v.createUploadQueue(config);
    assert.deepEqual(queue.map((x: any) => x.product.displayName), ['First', 'Second']);
    products[0].displayName = 'changed'; assert.equal(queue[0].product.displayName, 'First');
    assert.throws(() => v.createUploadQueue({ ...config, videos: [{ path: 'a' }] }));
    assert.equal(v.spinText('{hello|hi} {a|{b|c}}', () => 0), 'hello a');
    assert.equal(v.buildCaption({ description: 'Video' }, { ...defaults.upload, captions: ['Fallback'], hashtags: ['#one', 'two'] }), 'Video #one #two');
    const profile = { ...defaults.profile, isChangeName: true, names: ['A', 'B'], avoidDuplicateContent: true };
    assert.notEqual(v.allocateProfile(profile, () => 0).name, v.allocateProfile(profile, () => 0).name);
  });
  await test('account import preserves absent fields; Excel export preserves literal values', async () => {
    const [a] = parseAccounts('demo|secret|demo@outlook.com|mailpass', 'UID|PASS|MAIL|PASSMAIL');
    assert.equal(a.username, 'demo'); assert.equal(a.passMail, 'mailpass'); assert.equal('cookie' in a, false);
    assert.throws(() => parseAccounts('demo|secret|invalid|pass', 'UID|PASS|MAIL|PASSMAIL'));
    assert.equal(formatAccounts([a], 'MAIL|UID'), 'demo@outlook.com|demo');
    const file = path.join(output, 'accounts.xlsx');
    await exportAccounts(file, [{ ...a, notes: '=1+1', status: 'authenticated' }], '', true, () => 'Group');
    const { Workbook } = require('exceljs'); const workbook = new Workbook(); await workbook.xlsx.readFile(file);
    assert.equal(workbook.worksheets[0].getCell('K2').value, '=1+1'); assert.equal(workbook.worksheets[0].getCell('J2').value, 'Group');
  });
  await test('proxy, cookie and login classification', () => {
    assert.equal(parseProxy('localhost:80', 'http').server, 'http://localhost');
    assert.equal(parseProxy('localhost:8080:user:pass', 'http').username, 'user');
    assert.throws(() => parseProxy('localhost:1080:user:pass', 'socks5'));
    assert.throws(() => parseProxy('localhost:8080/path', 'http'));
    assert.throws(() => parseProxy('key', 'tmproxy'));
    assert.equal(parseCookies('sessionid=abc==; test=value')[0].value, 'abc==');
    assert.equal(parseCookies(JSON.stringify([{ name: 'x', value: 'y', domain: 'tiktok.com.evil.test' }])).length, 0);
    assert.equal(loginIdentifier({ uid: '123456', username: '123456', email: 'a@outlook.com' }), 'a@outlook.com');
    assert.equal(isEmailChallenge('Enter code sent to your email'), true);
    assert.equal(isEmailChallenge('Enter code from your authenticator. Try email instead'), false);
    assert.equal(trustedMicrosoftUrl('https://login.live.com.evil.test'), false);
  });
  await test('fresh OTP rejects wrong sender, recipient, old and ambiguous mail', () => {
    const now = Date.now();
    const mail = { from: { emailAddress: { address: 'noreply@account.tiktok.com' } }, toRecipients: [{ emailAddress: { address: 'a@outlook.com' } }], receivedDateTime: new Date(now).toISOString(), subject: 'Verification code', body: { content: '<b>012345</b>' } };
    assert.equal(extractMailCode(mail, 'a@outlook.com', now - 1000, now), '012345');
    assert.equal(extractMailCode(mail, 'b@outlook.com', now - 1000, now), undefined);
    assert.equal(extractMailCode(mail, 'a@outlook.com', now + 1, now), undefined);
    assert.equal(extractMailCode({ ...mail, from: { emailAddress: { address: 'noreply@account.tiktok.com.evil.test' } } }, 'a@outlook.com', now - 1000, now), undefined);
    assert.equal(extractMailCode({ ...mail, body: { content: '123456 654321' } }, 'a@outlook.com', now - 1000, now), undefined);
    assert.equal(extractMailCode({ ...mail, body: { content: '<script>999999</script>&#48;12345' } }, 'a@outlook.com', now - 1000, now), '012345');
  });
  await test('queue assigns once, honors concurrency and waits for failures to settle', async () => {
    let active = 0, peak = 0; const done: number[] = [];
    await pooled(Array.from({ length: 20 }, (_, i) => i), 3, signal, async (i: number) => { active++; peak = Math.max(peak, active); await delay(2, signal); done.push(i); active--; });
    assert.equal(peak, 3); assert.equal(new Set(done).size, 20);
    let settled = false;
    await assert.rejects(pooled([1, 2], 2, signal, async (i: number) => { if (i === 1) throw new Error('fixture'); await delay(20, signal); settled = true; })); assert.equal(settled, true);
    const controller = new AbortController(); const waiting = delay(60000, controller.signal); controller.abort(); await assert.rejects(waiting, /Đã dừng/);
  });
  await test('Outlook device grant verifies exact mailbox and refreshes tokens', async () => {
    const calls: string[] = []; let mismatch = false;
    const fetcher = async (url: string) => {
      calls.push(url);
      if (url.endsWith('devicecode')) return Response.json({ user_code: 'ABCD', device_code: 'device', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 60, interval: 5 });
      if (url.endsWith('token')) return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
      if (url.includes('/me?$select')) return Response.json({ mail: mismatch ? 'wrong@outlook.com' : 'fixture@outlook.com' });
      throw new Error('Unexpected request');
    };
    const outlook = new OutlookService(output, fetcher); let code = '';
    await outlook.connect('fixture@outlook.com', signal, (c: string) => code = c);
    assert.equal(code, 'ABCD'); assert.equal(await outlook.accessToken('fixture@outlook.com', signal), 'access');
    await outlook.accessToken('fixture@outlook.com', signal, true); assert.equal(calls.filter(u => u.endsWith('token')).length, 2);
    mismatch = true; await assert.rejects(outlook.connect('second@outlook.com', signal, () => {}), /email khác/);
    assert.equal(await outlook.connected('second@outlook.com', signal), false);
  });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(2500);
    await test('video actions do not undo existing actions; video and live comments', async () => {
      await page.setContent(`<button data-e2e="like-icon" onclick="this.setAttribute('aria-pressed','true');window.likes++">Like</button><button data-e2e="favorite-icon" onclick="this.setAttribute('aria-pressed','true');window.favorites++">Favorite</button><button data-e2e="follow-button" onclick="this.textContent='Following';window.follows++">Follow</button><div data-e2e="comment-input" contenteditable="true"></div><button data-e2e="comment-post" onclick="window.comments++;document.querySelector('[contenteditable]').textContent=''">Post</button><script>window.likes=window.favorites=window.follows=window.comments=0</script>`);
      const config = { ...defaults.video, minViewSeconds: 0, maxViewSeconds: 0, minDelaySeconds: 0, maxDelaySeconds: 0, isFollow: true, isFavorite: true, comments: ['Hello'] };
      await seedVideo(page, config, signal, () => {}); await seedVideo(page, config, signal, () => {});
      assert.deepEqual(await page.evaluate(() => [window['likes'], window['favorites'], window['follows'], window['comments']]), [1, 1, 1, 2]);
      await page.setContent(`<div data-e2e="room-chat-input-field" contenteditable="true" onkeydown="if(event.key==='Enter'){this.textContent='';event.preventDefault()}"></div>`); await sendComment(page, 'Live fixture', true, signal);
    });
    await test('profile patch returned only after saving', async () => {
      await page.setContent(`<button data-e2e="edit-profile-entrance">Edit profile</button><div data-e2e="edit-profile-popup"><input name="nickname"><input name="uniqueId"><textarea name="bio"></textarea><button data-e2e="edit-profile-save" onclick="this.parentElement.remove()">Save</button></div>`);
      const result = await updateProfile(page, { ...defaults.profile, minDelaySeconds: 0, maxDelaySeconds: 0 }, { name: 'Demo', username: 'demo_123', bio: 'Hello' }, signal, () => {});
      assert.deepEqual(result, { displayName: 'Demo', username: 'demo_123', uid: 'demo_123', bio: 'Hello' });
    });
    const file = path.join(output, 'fixture.mp4'); fs.writeFileSync(file, 'local file input fixture');
    const item = { path: file, title: 'Fixture', description: 'Caption', size: '24', product: { id: '123', displayName: 'Demo product' } };
    function fixture(disabled = false) {
      return `<input type="file"><div contenteditable="true"></div><div data-e2e="video_visibility_container"><button>Public</button></div><div class="anchor-tag-container"><button class="add-first-btn" onclick="document.getElementById('wizard').hidden=false">Add product</button></div><div id="wizard" hidden><div class="product-selector-container"><input class="TUXTextInputCore-input"><table><tr><td>123</td><td><input type="radio" ${disabled ? 'disabled' : ''}></td></tr></table></div><div class="common-modal-footer"><button class="TUXButton--primary" onclick="document.getElementById('wizard').remove();document.querySelector('.anchor-tag-container').textContent='Demo product 123'">Confirm</button></div></div><button data-e2e="post_video_button" onclick="window.posts++;document.getElementById('result').innerHTML='<div data-e2e=upload-success>Success</div>'">Post</button><div id="result"></div><script>window.posts=0</script>`;
    }
    await test('upload publishes once after exact product attachment', async () => {
      await page.setContent(fixture()); const result = await uploadVideo(page, item, { ...defaults.upload, attachProducts: true, postWaitSeconds: 1 }, signal, () => {});
      assert.match(result.message, /xác nhận/); assert.equal(await page.evaluate(() => window['posts']), 1);
    });
    await test('ineligible product prevents publish', async () => {
      await page.setContent(fixture(true)); await assert.rejects(uploadVideo(page, item, { ...defaults.upload, attachProducts: true }, signal, () => {}), /không đủ điều kiện/); assert.equal(await page.evaluate(() => window['posts']), 0);
    });
    await test('ambiguous publishing timeout never retries', async () => {
      await page.setContent(fixture()); await page.locator('[data-e2e=post_video_button]').evaluate((el: HTMLElement) => el.setAttribute('onclick', 'window.posts++'));
      await assert.rejects(uploadVideo(page, item, { ...defaults.upload, postWaitSeconds: 1 }, signal, () => {}), /tránh đăng trùng/); assert.equal(await page.evaluate(() => window['posts']), 1);
    });
    await test('verification screen cannot count as logged in', async () => {
      await page.setContent('<div data-e2e="profile"></div><div data-e2e="avatar"></div><input name="code">'); assert.equal(await authenticated(page), false);
      await page.setContent('<div data-e2e="profile">Creator profile</div><div data-e2e="avatar">Creator avatar</div>'); assert.equal(await authenticated(page), false);
    });
  } finally { await browser.close(); }
  await test('IPC rejects foreign frames, concurrent starts and canceled license checks', async () => {
    const { NativeWorkflowService: WorkflowService } = source('native-service');
    const originalRun = WorkflowService.prototype.run, originalCancel = WorkflowService.prototype.cancel;
    let runs = 0, finish: any, licenseFinish: any;
    WorkflowService.prototype.run = function () { runs++; return new Promise(resolve => { finish = resolve; }); };
    WorkflowService.prototype.cancel = async function () { finish?.({ success: false, canceled: true }); };
    try {
      const record = { id: 'account', username: 'demo', cookie: 'preserved' };
      const accounts = { getAccountById: () => record, getAllAccounts: () => [record], updateAccount: (_id: string, patch: any) => Object.assign(record, patch), getAllCategories: () => [] };
      let license = async () => ({ ok: true });
      const webContents = { mainFrame: {} }, event = { sender: webContents, senderFrame: webContents.mainFrame };
      source('ipc').setupWorkflowIPC(accounts, { addLog: () => {} }, { ensureLicensed: () => license() }, () => ({ webContents }));
      const invoke = (action: string, payload: any = {}) => handlers.workflows(event, action, payload);
      await assert.rejects(handlers.workflows({ sender: webContents, senderFrame: {} }, 'state'), /IPC/);
      await invoke('import-text', { text: 'demo|changed', format: 'UID|PASS' }); assert.equal(record.cookie, 'preserved');
      await invoke('start', { command: 'login', accountIds: ['account'] }); assert.equal(runs, 1);
      await assert.rejects(invoke('start', { command: 'login', accountIds: ['account'] }), /đang chạy/);
      await invoke('cancel'); await delay(0, signal); assert.equal((await invoke('state')).isRunning, false);
      license = () => new Promise(resolve => { licenseFinish = resolve; });
      const start = invoke('start', { command: 'login', accountIds: ['account'] }); const rejected = assert.rejects(start, /hủy khởi chạy/);
      await invoke('cancel'); licenseFinish({ ok: true }); await rejected; assert.equal(runs, 1);
      assert.equal((await invoke('state')).isRunning, false);
    } finally { WorkflowService.prototype.run = originalRun; WorkflowService.prototype.cancel = originalCancel; }
  });
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: true, checks }, null, 2)); console.log(`Verified ${checks.length} workflow checks.`);
}
main().catch((error: Error) => { console.error(error); process.exitCode = 1; });
