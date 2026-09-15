const {app}=require('electron');
const fs=require('node:fs'), path=require('node:path');
const {BrowserPool}=require('../dist/main/workflows/browser');
const {authenticated}=require('../dist/main/workflows/login');
const {openSeedingTarget}=require('../dist/main/workflows/navigation');
app.setPath('userData',path.join(process.env.APPDATA,'electron-nest-react'));
app.whenReady().then(async()=>{
 const root=path.join(process.env.APPDATA,'electron-nest-react/data');
 const accounts=JSON.parse(fs.readFileSync(path.join(root,'accounts.json'),'utf8'));
 const settings=JSON.parse(fs.readFileSync(path.join(root,'workflows/settings.json'),'utf8'));
 const pool=new BrowserPool(path.join(root,'workflows'),{emit:()=>{},update:()=>{}});
 const out=path.resolve('tmp/account-navigation');fs.mkdirSync(out,{recursive:true});
 const report=[];
 try {
 for(const account of accounts){
  for(const key of ['cookie','password','email','passMail','twoFactor','proxy','token','recoveryMail']) account[key]=require('../dist/main/secret-json').decryptSecret(account[key]);
  if (account.cookie.startsWith('enc:v1:') || account.password.startsWith('enc:v1:')) throw new Error('Không giải mã được thông tin tài khoản; dừng kiểm thử.');
  console.log('ACCOUNT',account.username, 'encryptedCookie', account.cookie.startsWith('enc:v1:'), 'cookieCount', require('../dist/main/workflows/browser').parseCookies(account.cookie).length);
  let page;try{page=await pool.open(account,settings,0,new AbortController().signal);}catch(e){report.push({account:account.username,error:e.message});continue;}
  for(const [label,url] of [['home','https://www.tiktok.com'],['video','https://www.tiktok.com/@phung_an02/video/7655347871339924743?is_from_webapp=1&sender_device=pc']]){
   let error;let status;
   const onResponse=r=>{if(r.request().isNavigationRequest()&&r.frame()===page.mainFrame())status=r.status();};page.on('response',onResponse);
   try{await openSeedingTarget(page,url,new AbortController().signal,console.log);}catch(e){error=e.message;}
   await page.waitForTimeout(4000); if(label==='home') { try { await require('../dist/main/workflows/login').ensureLogin(page,account,new (require('../dist/main/workflows/outlook').OutlookService)(path.join(root,'workflows')),new AbortController().signal,console.log,()=>{},1); } catch(e) { console.log('LOGIN',e.message); } } page.off('response',onResponse);
   const item={account:account.username,label,status,error,url:page.url(),title:await page.title(),authenticated:await authenticated(page),video:await page.locator('video').evaluateAll(v=>v.map(x=>({time:x.currentTime,ready:x.readyState}))),body:(await page.locator('body').innerText()).slice(0,700)};
   report.push(item);console.log(JSON.stringify(item));await page.screenshot({path:path.join(out,account.username+'-'+label+'.png')});
  }
  await pool.close([account.id]);
 }
 }finally{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));await pool.close();}
 app.exit(0);
}).catch(e=>{console.error(e.message);app.exit(1);});
