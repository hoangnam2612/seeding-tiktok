const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const source = fs.readFileSync('src/renderer/src/App.tsx', 'utf8');
const handlers = source.slice(source.indexOf('  const openManagedChromes ='), source.indexOf('  const handleClearLogs ='));
const calls = [];
const context = {
  requireValidLicense: async () => true,
  window: { electronAPI: {
    workflows: async (...args) => calls.push(args),
    closeAllBrowserWindows: async () => calls.push(['legacy-close']),
    openAccountLoginWindow: () => assert.fail('Must not open an Electron window'),
    openMultiAccountChromes: () => assert.fail('Must not open Electron windows'),
  } },
  selectedAccountIds: ['one', 'two'], maxThreads: 4, muteLoginBrowserAudio: true,
  alert: () => {}, setIsTaskExecuting: () => {},
};
vm.createContext(context);
vm.runInContext(ts.transpileModule(handlers + '\nglobalThis.actions = { handleOpenSingleChrome, handleOpenMultiChromes, handleCloseAllBrowserWindows };', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
(async () => {
  await context.actions.handleOpenSingleChrome({ id: 'one' });
  await context.actions.handleOpenMultiChromes();
  await context.actions.handleCloseAllBrowserWindows();
  const normalized = JSON.parse(JSON.stringify(calls));
  assert.deepEqual(normalized, [
    ['start', { command: 'login', accountIds: ['one'], config: {}, browserOverrides: { maxThreads: 4, disableAudio: true } }],
    ['start', { command: 'login', accountIds: ['one', 'two'], config: {}, browserOverrides: { maxThreads: 4, disableAudio: true } }],
    ['cancel'], ['legacy-close'],
  ]);
  assert.match(source, /onClick=\{handleOpenMultiChromes\}/);
  assert.match(source, /onClick=\{\(\) => handleOpenSingleChrome\(acc\)\}/);
  assert.match(source, /onClick=\{handleCloseAllBrowserWindows\}/);
  console.log('PASS: account single/multi Chrome buttons use workflow Chrome; close cancels workflow and closes legacy windows.');
})().catch(error => { console.error(error); process.exitCode = 1; });
