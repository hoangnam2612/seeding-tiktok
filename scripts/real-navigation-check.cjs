const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const { openSeedingTarget } = require('../dist/main/workflows/navigation');
(async () => {
 const output = path.resolve(process.argv.includes('--block-images') ? 'tmp/real-navigation-block-images' : 'tmp/real-navigation'); fs.mkdirSync(output, {recursive:true});
 const context = await chromium.launchPersistentContext(path.join(output,'profile'), {channel:'chrome',headless:true,locale:'vi-VN',args:['--mute-audio']});
 if (process.argv.includes('--block-images')) await context.route('**/*', route => route.request().resourceType() === 'image' ? route.abort() : route.continue());
 const page = context.pages()[0];
 const report = [];
 page.on('response', r => { if(r.request().isNavigationRequest()) console.log('HTTP',r.status(),r.url()); });
 try {
  for(const url of ['https://www.tiktok.com','https://www.tiktok.com/@phung_an02/video/7655347871339924743?is_from_webapp=1&sender_device=pc']) {
   let error; try { await openSeedingTarget(page,url,new AbortController().signal, console.log); } catch(e) {error=e.message;}
   await page.waitForTimeout(3000);
   const item={url, finalUrl:page.url(), error, title:await page.title(), body:(await page.locator('body').innerText()).slice(0,2500), videos:await page.locator('video').count()};
   report.push(item); console.log(JSON.stringify(item));
   await page.screenshot({path:path.join(output,report.length+'.png')});
  }
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
 } finally {await context.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
