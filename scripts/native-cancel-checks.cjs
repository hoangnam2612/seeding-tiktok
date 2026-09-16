const assert = require('assert/strict');
const Module = require('module');
const original = Module._load;
Module._load = function(id, ...args) {
  if (id === 'electron') return { app: {}, screen: {} };
  return original.call(this, id, ...args);
};
const { NativeWorkflowService } = require('../dist/main/workflows/native-service');
(async () => {
  const service = Object.create(NativeWorkflowService.prototype);
  let terminated = 0;
  service.child = {};
  service.request = async () => ({ success: true });
  service.terminate = async () => { terminated++; };
  await service.cancel();
  assert.equal(terminated, 0);
  service.request = async () => { throw Error('Engine disconnected'); };
  await service.cancel();
  assert.equal(terminated, 1);
  service.terminate = async () => { throw Error('Cannot terminate'); };
  await assert.rejects(service.cancel(), /Cannot terminate/);
  const oldTimeout = global.setTimeout;
  try {
    global.setTimeout = (callback, delay) => oldTimeout(callback, delay === 15000 ? 5 : delay);
    service.request = () => new Promise(() => {});
    service.terminate = async () => { terminated++; };
    await service.cancel();
    assert.equal(terminated, 2);
  } finally { global.setTimeout = oldTimeout; }
  console.log('PASS cancellation: graceful stop, successful fallback, failed termination and unresponsive engine timeout.');
})().catch(error => { console.error(error); process.exitCode = 1; });
