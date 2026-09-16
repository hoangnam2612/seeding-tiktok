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
const fixtures = { RecoveryMail: 'recovery@example.com', USER: 'demo', PASS: 'password', MAIL: 'mail@example.com', 'PASS MAIL': 'secret', refresh_token: 'fixture-refresh-token', client_id: 'fixture-client-id', User: 'demo', Pass: 'password', Mail: 'mail@example.com', Email: 'mail@example.com', PassMail: 'secret', Cookie: 'opaque-cookie', '2FA': 'key;with-semicolon', Proxy: '127.0.0.1:8080' };
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

service.accounts = [];
let oauth = service.batchImportAccounts('oauth|password|mail@example.com|mailpass|fixture-token|fixture-client');
assert.equal(oauth.addedCount, 1);
assert.equal(service.accounts[0].refreshToken, 'fixture-token');
assert.equal(service.accounts[0].clientId, 'fixture-client');
assert.equal(service.accounts[0].proxy, '');
assert.equal(service.accounts[0].twoFactor, '');
service.accounts[0].cookie = 'sessionid=preserved';
service.batchImportAccounts('oauth|password|mail@example.com|mailpass|updated-token|fixture-client');
assert.equal(service.accounts[0].cookie, 'sessionid=preserved');
assert.equal(service.accounts[0].refreshToken, 'updated-token');
console.log('PASS OAuth mail six-column auto import and update.');

service.accounts = [];
const cookieFixture = 'tt_csrf_token=fixture; sessionid=fixture-session; ttwid=1%7Cfixture';
const eightColumns = 'eight|password|mail@example.com|mailpass|refresh-fixture|client-fixture|recovery@example.com|' + cookieFixture;
result = service.batchImportAccounts(eightColumns + '\nlegacy|password');
assert.equal(result.addedCount, 2);
assert.equal(service.accounts[0].cookie, cookieFixture);
assert.equal(service.accounts[0].recoveryMail, 'recovery@example.com');
assert.equal(service.accounts[0].refreshToken, 'refresh-fixture');
assert.equal(service.accounts[0].clientId, 'client-fixture');
assert.equal(service.accounts[0].proxy, '');
result = service.batchImportAccounts(eightColumns.replace('recovery@example.com', 'updated@example.com'));
assert.equal(result.updatedCount, 1);
assert.equal(service.accounts[0].recoveryMail, 'updated@example.com');
result = service.batchImportAccounts(eightColumns.replace(cookieFixture, ''));
assert.equal(service.accounts[0].cookie, cookieFixture);
assert.equal(service.batchImportAccounts(eightColumns.replace('recovery@example.com', 'invalid')).skippedCount, 1);
assert.equal(service.batchImportAccounts(eightColumns + '|extra').skippedCount, 1);
result = service.batchImportAccounts('reordered|recovery@example.com|' + cookieFixture, undefined, undefined, 'User | Recovery_Mail | Cookie');
assert.equal(result.addedCount, 1);
assert.equal(service.accounts[2].recoveryMail, 'recovery@example.com');
console.log('PASS eight-column auto import, mixed lines, updates, malformed input and custom recovery mail.');
