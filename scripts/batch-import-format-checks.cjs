const assert = require('assert/strict');
const Module = require('module');
const original = Module._load;
Module._load = function(id, ...args) {
  if (id === 'electron') return { app: {}, safeStorage: {} };
  return original.call(this, id, ...args);
};
const { AccountsService } = require('../dist/main/nest/accounts/accounts.service');
const { ACCOUNT_IMPORT_FORMATS } = require('../dist/shared/account-import-format');
const service = Object.create(AccountsService.prototype);
service.accounts = [];
service.saveAccounts = () => {};
const fixtures = { User: 'demo', Pass: 'password', Mail: 'mail@example.com', Email: 'mail@example.com', PassMail: 'secret', Cookie: 'opaque-cookie', '2FA': 'key;with-semicolon', Proxy: '127.0.0.1:8080' };
for (const format of ACCOUNT_IMPORT_FORMATS) {
  service.accounts = [];
  const result = service.batchImportAccounts(format.split(' | ').map(key => fixtures[key]).join('|'), undefined, undefined, format);
  assert.equal(result.addedCount, 1, format);
  if (format.includes('Cookie')) assert.equal(service.accounts[0].cookie, 'opaque-cookie');
  if (format.includes('2FA')) assert.equal(service.accounts[0].twoFactor, 'key;with-semicolon');
}
service.accounts = [];
let result = service.batchImportAccounts('mail@example.com|demo|secret|password', undefined, undefined, 'Email | User | PassMail | Pass');
assert.equal(result.addedCount, 1);
assert.equal(service.accounts[0].passMail, 'secret');
service.accounts[0].cookie = 'sessionid=preserve';
service.batchImportAccounts('mail@example.com|demo|new|updated', undefined, undefined, 'Email | User | PassMail | Pass');
assert.equal(service.accounts[0].cookie, 'sessionid=preserve');
result = service.batchImportAccounts('short|password\nvalid|password|mail@example.com', undefined, undefined, 'User|Pass|Mail');
assert.equal(result.skippedCount, 1);
assert.equal(result.addedCount, 1);
for (const format of ['', 'User|Unknown', 'User|Mail|Email', 'Mail|Pass', 'User||Pass']) {
  assert.throws(() => service.batchImportAccounts('demo|password', undefined, undefined, format));
}
console.log('PASS all preset formats, custom ordering, explicit detection overrides, column validation and cookie preservation.');
