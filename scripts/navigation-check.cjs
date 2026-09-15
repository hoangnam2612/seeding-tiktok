const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { openSeedingTarget } = require('../dist/main/workflows/navigation');
class FakePage extends EventEmitter {
  constructor(steps) { super(); this.steps = steps; this.calls = 0; }
  async goto() { const next = this.steps[this.calls++]; if (next instanceof Error) throw next; return { status: () => next }; }
}
(async () => {
  const signal = new AbortController().signal;
  const ok = new FakePage([200]);
  await openSeedingTarget(ok, 'https://www.tiktok.com/test', signal, () => {});
  assert.equal(ok.calls, 1);
  for (const status of [403, 404, 429]) {
    const page = new FakePage([status]);
    await assert.rejects(openSeedingTarget(page, 'https://www.tiktok.com/test', signal, () => {}), new RegExp('HTTP ' + status));
    assert.equal(page.calls, 1); assert.equal(page.listenerCount('response'), 0);
  }
  const retry = new FakePage([new Error('net::ERR_HTTP_RESPONSE_CODE_FAILURE'), 200]);
  await openSeedingTarget(retry, 'https://www.tiktok.com/test', signal, () => {});
  assert.equal(retry.calls, 2); assert.equal(retry.listenerCount('response'), 0);
  const controller = new AbortController();
  const cancel = new FakePage([503]);
  await assert.rejects(openSeedingTarget(cancel, 'https://www.tiktok.com/test', controller.signal, () => controller.abort()), /Đã dừng/);
  assert.equal(cancel.calls, 1);
  console.log('PASS: success, HTTP errors, retry, cancellation, listener cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; });
