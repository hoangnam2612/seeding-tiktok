// Exercise the production Chrome pool with isolated profiles and no account actions.
const { app, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve(__dirname, '../tmp/browser-layout-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'electron'));
app.whenReady().then(async () => {
  const { BrowserPool, browserBounds } = require('../dist/main/workflows/browser');
  const { browserDefaults } = require('../dist/main/workflows/contracts');
  const pool = new BrowserPool(path.join(output, `run-${Date.now()}`), { emit: console.log, update() {} });
  const signal = new AbortController().signal;
  const results = [];
  async function open(id, settings, slot) {
    const page = await pool.open({ id, username: id }, settings, slot, signal);
    await page.setContent(`<title>Chrome layout test ${id}</title><style>body{background:#101827;color:white;font:24px sans-serif;padding:24px}</style><h1>${id}</h1><p>Chrome layout / C# parity</p><p>Scale: ${settings.scaleFactor * 100}%</p>`);
    const session = await page.context().newCDPSession(page);
    const { bounds } = await session.send('Browser.getWindowForTarget');
    await session.detach();
    const expected = browserBounds(settings, slot, screen.getPrimaryDisplay().workArea);
    // Native integer pixels can round by up to two Chrome units at 65% scale.
    for (const key of ['width', 'height', 'left', 'top']) assert.ok(Math.abs(bounds[key] - expected[key]) <= 2, `${id} ${key}: ${bounds[key]} != ${expected[key]}`);
    const metrics = await page.evaluate(() => ({ outerWidth, outerHeight, screenX, screenY, devicePixelRatio }));
    results.push({ id, expected, bounds, metrics });
    return page;
  }
  try {
    for (let i = 0; i < 4; i++) await open(`slot-${i}`, browserDefaults, i);
    await pool.close(['slot-1']);
    await open('reused-slot-1', browserDefaults, 1);
    await pool.close();
    await open('custom-size', { ...browserDefaults, windowWidth: 680, windowHeight: 640, scaleFactor: .8 }, 0);
    await pool.close();
    for (let i = 0; i < 3; i++) await open(`row-${i}`, { ...browserDefaults, columns: 2 }, i);
    await pool.close();
    await open('system-scale', { ...browserDefaults, scaleFactor: 1 }, 0);
    await pool.close();
    for (let i = 0; i < 4; i++) await open(`preview-${i}`, browserDefaults, i);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: true, display: screen.getPrimaryDisplay(), results }, null, 2));
    console.log('PASS: four columns, second row, slot reuse, custom size, 65%, 80% and system scale. Preview windows remain for 120 seconds.');
    setTimeout(async () => { await pool.close(); app.exit(0); }, 120000);
  } catch (error) {
    console.error(error);
    await pool.close();
    app.exit(1);
  }
});
