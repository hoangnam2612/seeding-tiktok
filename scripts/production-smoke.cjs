const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'seeding-tiktok-prod-smoke-'));
process.env.APPDATA = tempRoot;

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        isReady: () => false,
        getPath: () => tempRoot,
      },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: value => Buffer.from(`sealed:${value}`, 'utf8'),
        decryptString: buffer => {
          const raw = Buffer.from(buffer).toString('utf8');
          return raw.startsWith('sealed:') ? raw.slice('sealed:'.length) : raw;
        },
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assertEncrypted(value, label) {
  assert.strictEqual(typeof value, 'string', `${label} should be a string`);
  assert.ok(value.startsWith('enc:v1:'), `${label} should be encrypted at rest`);
}

try {
  const dataDir = path.join(tempRoot, 'Seeding TikTok', 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  fs.writeFileSync(path.join(dataDir, 'categories.json'), JSON.stringify([
    { id: 'cat_default', name: 'Default', createdAt: new Date().toISOString() },
  ]));
  fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify([
    {
      id: 'acc_1',
      username: 'user_one',
      password: 'plain-password',
      displayName: 'User One',
      categoryId: 'cat_default',
      cookie: 'sessionid=plain-cookie',
      email: 'user@example.com',
      passMail: 'plain-mail-password',
      twoFactor: 'JBSWY3DPEHPK3PXP',
      proxy: '1.2.3.4:8080',
      proxyType: 'http',
      status: 'authenticated',
      createdAt: new Date().toISOString(),
    },
  ]));
  fs.writeFileSync(path.join(dataDir, 'proxies.json'), JSON.stringify([
    {
      id: 'proxy_1',
      value: '1.2.3.4:8080',
      proxyType: 'http',
      assignedAccountId: 'acc_1',
      status: 'untested',
      createdAt: new Date().toISOString(),
    },
  ]));
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ omocaptchaApiKey: 'plain-omo-key' }));

  const { AccountsService } = require('../dist/main/nest/accounts/accounts.service.js');
  const { AppService } = require('../dist/main/nest/app.service.js');
  const { getApiAuthToken, isValidApiAuthToken } = require('../dist/main/api-auth.js');

  const accountsService = new AccountsService();
  accountsService.onModuleInit();

  const loadedAccount = accountsService.getAccountById('acc_1');
  assert.strictEqual(loadedAccount.password, 'plain-password');
  assert.strictEqual(loadedAccount.cookie, 'sessionid=plain-cookie');
  assert.strictEqual(loadedAccount.passMail, 'plain-mail-password');

  const storedAccount = readJson(path.join(dataDir, 'accounts.json'))[0];
  assertEncrypted(storedAccount.password, 'account password');
  assertEncrypted(storedAccount.cookie, 'account cookie');
  assertEncrypted(storedAccount.passMail, 'account passMail');
  assertEncrypted(storedAccount.twoFactor, 'account twoFactor');
  assertEncrypted(storedAccount.proxy, 'account proxy');

  const storedProxy = readJson(path.join(dataDir, 'proxies.json'))[0];
  assertEncrypted(storedProxy.value, 'proxy value');

  const updateCount = accountsService.bulkUpdateProxy(['acc_1'], [], 'http');
  assert.strictEqual(updateCount, 0, 'empty proxy bulk update should be ignored');

  const deleted = accountsService.deleteAccount('acc_1');
  assert.strictEqual(deleted, true);
  assert.strictEqual(accountsService.getAllProxies()[0].assignedAccountId, undefined);

  const appService = new AppService();
  assert.strictEqual(appService.getSettings().omocaptchaApiKey, 'plain-omo-key');
  const storedSettings = readJson(path.join(dataDir, 'settings.json'));
  assertEncrypted(storedSettings.omocaptchaApiKey, 'OmoCaptcha key');

  const token = getApiAuthToken();
  assert.strictEqual(isValidApiAuthToken(token), true);
  assert.strictEqual(isValidApiAuthToken('bad-token'), false);
  assert.strictEqual(isValidApiAuthToken(undefined), false);

  console.log('Production smoke checks passed');
} finally {
  Module._load = originalLoad;
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
