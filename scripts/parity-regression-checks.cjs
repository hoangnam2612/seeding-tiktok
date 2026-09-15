const fs=require('fs'),path=require('path'),assert=require('assert/strict'),ts=require('typescript'),Module=require('module');
const root=process.cwd(),output=path.join(root,'tmp/parity-regression'); fs.mkdirSync(output,{recursive:true});
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,experimentalDecorators:true,emitDecoratorMetadata:true}}).outputText,file);
const load=Module._load;
Module._load=function(id,...args){if(id==='electron')return {app:{isReady:()=>true,getPath:()=>output},screen:{},safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}};return load.call(this,id,...args)};
 const findings=[];
(async()=>{
 const {ClientAuthService}=require(path.join(root,'src/main/nest/client-auth/client-auth.service.ts'));
 const auth=Object.create(ClientAuthService.prototype);
 auth.getMe=async()=>({success:false,statusCode:403,message:'fixture server denied'});
 auth.getPublicState=()=>({authenticated:true,licensed:true,blocked:false});
 const result=await auth.ensureLicensed();assert.equal(result.ok,false);
 findings.push({case:'auth-denied-with-cached-license',observed:'Denied response correctly blocks cached license'});
 auth.settings={appCode:'TIKMAX'};auth.getMachineHwid=()=> 'fixture';
 auth.request=async()=>({success:true,data:{accessToken:'a',refreshToken:'r',appCode:'WRONG'}});
 auth.saveState=()=>assert.fail('Wrong product must not be saved');
 assert.equal((await auth.login('fixture','fixture')).success,false);
 findings.push({case:'wrong-product',observed:'Wrong app code rejected before token persistence'});
 let remoteLogout=false,cleared=false;
 auth.readState=()=>({accessToken:'fixture',refreshToken:'fixture'});
 auth.request=async endpoint=>{remoteLogout=endpoint==='/api/auth/logout';return {success:true}};
 auth.saveState=value=>{cleared=Object.keys(value).length===0};await auth.logout();assert(remoteLogout&&cleared);
 findings.push({case:'logout',observed:'Server logout called and local session cleared'});
 const {loadAuthSettings}=require(path.join(root,'src/main/nest/client-auth/auth-settings.ts'));
 const priorUrl=process.env.AUTH_BASE_URL,priorCode=process.env.AUTH_APP_CODE;
 try {
  process.chdir(output);fs.mkdirSync('settings',{recursive:true});fs.writeFileSync('settings/auth_config.json',JSON.stringify({AuthBaseUrl:'https://file.example.test/',AppCode:'tikmax'}));
  delete process.env.AUTH_BASE_URL;delete process.env.AUTH_APP_CODE;
  assert.deepEqual(loadAuthSettings('https://fallback.example.test'),{baseUrl:'https://file.example.test',appCode:'TIKMAX'});
  process.env.AUTH_BASE_URL='https://env.example.test';process.env.AUTH_APP_CODE='other';
  assert.deepEqual(loadAuthSettings('https://fallback.example.test'),{baseUrl:'https://env.example.test',appCode:'OTHER'});
 } finally {process.chdir(root);if(priorUrl===undefined)delete process.env.AUTH_BASE_URL;else process.env.AUTH_BASE_URL=priorUrl;if(priorCode===undefined)delete process.env.AUTH_APP_CODE;else process.env.AUTH_APP_CODE=priorCode}
 findings.push({case:'auth-config',observed:'Case-insensitive file fields and environment precedence verified'});
 const remembered=Object.create(ClientAuthService.prototype);remembered.ensurePaths=()=>{};remembered.dataDir=output;
 remembered.rememberLogin('fixture-user','fixture-password',true);assert.deepEqual(remembered.getRememberedLogin(),{username:'fixture-user',password:'fixture-password'});
 remembered.rememberLogin('fixture-user','fixture-password',false);assert.equal(remembered.getRememberedLogin(),null);
 findings.push({case:'remember-login',observed:'Remembered credentials round-trip and opt-out clears stored entry (mock encryption; OS encryption checked separately in packaged tests)'});
 const {OutlookService}=require(path.join(root,'src/main/workflows/outlook.ts'));
 let browserStarted=false,browserStopped=false,polls=0;
 const outlook=new OutlookService(path.join(output,'concurrent-outlook'),async url=>{
  if(url.endsWith('devicecode'))return new Response(JSON.stringify({user_code:'ABCD',device_code:'fixture',verification_uri:'https://login.microsoftonline.com/device',expires_in:60}));
  if(url.endsWith('token')){assert(browserStarted);polls++;return new Response(JSON.stringify({access_token:'fixture',refresh_token:'fixture',expires_in:3600}))}
  return new Response(JSON.stringify({mail:'fixture@outlook.com'}));
 });
 await outlook.connect('fixture@outlook.com',new AbortController().signal,()=>{},async(_code,_url,signal)=>{browserStarted=true;await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));browserStopped=true});
 assert.equal(polls,1);assert(browserStopped);findings.push({case:'outlook-concurrent-poll',observed:'Token polling proceeds while browser waits; success cancels and joins browser step'});
 const loginModule=require(path.join(root,'src/main/workflows/login.ts'));
 const uploadModule=require(path.join(root,'src/main/workflows/upload.ts'));
 const originalLogin=loginModule.ensureLogin,originalUpload=uploadModule.uploadVideo;
 loginModule.ensureLogin=async()=>{};uploadModule.uploadVideo=async()=>({message:'fixture uploaded'});
 try {
  const {WorkflowService}=require(path.join(root,'src/main/workflows/service.ts'));
  const {defaults,browserDefaults}=require(path.join(root,'src/main/workflows/contracts.ts'));
  const events=[],service=new WorkflowService(output,{emit:e=>events.push(e),update:()=>{}});
  let opens=0,closes=0;
  service.browsers.open=async()=>{opens++;return {goto:async()=>{}}};service.browsers.close=async()=>{closes++};service.browsers.persist=async()=>{};
  const result=await service.run('upload',[{id:'fixture',username:'fixture'}],{...defaults.upload,videos:[{path:'one'},{path:'two'}]},browserDefaults);
  assert.equal(result.success,true);assert.equal(opens,2);assert.equal(events.filter(e=>e.type==='item').length,2);assert(closes>=2);
  findings.push({case:'upload-lifecycle',observed:'A browser opened for each video; queue assigned each item once'});
 } finally {loginModule.ensureLogin=originalLogin;uploadModule.uploadVideo=originalUpload}
 const {chromium}=require('playwright-core');const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();
  const {browserBounds,applyBrowserBounds}=require(path.join(root,'src/main/workflows/browser.ts'));
  const {browserDefaults}=require(path.join(root,'src/main/workflows/contracts.ts'));
  const layout={...browserDefaults,columns:4,rows:2,windowWidth:0,windowHeight:0};
  assert.deepEqual(browserBounds(layout,5,{x:20,y:30,width:1200}),{width:600,height:533,left:620,top:563});
  assert.deepEqual(browserBounds({...layout,autoArrangeGrid:false},13,{x:20,y:30,width:1200}),browserBounds(layout,5,{x:20,y:30,width:1200}));
  assert.deepEqual(browserBounds({...layout,windowWidth:800,windowHeight:900},0,{x:0,y:0,width:1920}),{width:800,height:700,left:0,top:0});
  await applyBrowserBounds(page,{width:900,height:650,left:40,top:50});
  const boundsSession=await page.context().newCDPSession(page);
  const measured=await boundsSession.send('Browser.getWindowForTarget');
  assert.equal(measured.bounds.width,900);assert.equal(measured.bounds.height,650);assert.equal(measured.bounds.left,40);assert.equal(measured.bounds.top,50);await boundsSession.detach();
  findings.push({case:'browser-layout',observed:'Reference size order, grid wrap and disabled flag match; Chrome confirms bounds set after launch'});
  const {follow}=require(path.join(root,'src/main/workflows/seeding.ts'));
  const {seedVideo}=require(path.join(root,'src/main/workflows/seeding.ts'));
  const {defaults}=require(path.join(root,'src/main/workflows/contracts.ts'));
  await page.setContent(`<button data-e2e="like-icon" onclick="throw new Error('fixture click failure')">Like</button><button data-e2e="follow-button" onclick="this.textContent='Following'">Follow</button>`);
  const warnings=[];const errors=await seedVideo(page,{...defaults.video,minViewSeconds:0,maxViewSeconds:0,minDelaySeconds:0,maxDelaySeconds:0,isLike:true,isFollow:true,isFavorite:false,isComment:false},new AbortController().signal,message=>warnings.push(message));
  assert.equal(errors,1);assert.equal(await page.locator('[data-e2e=follow-button]').innerText(),'Following');
  findings.push({case:'action-failure-continuation',observed:'Unconfirmed Like reported as failure; Follow still completed'});
  await page.setContent(`<button>Following</button><button data-e2e="follow-button" onclick="window.targetClicks++;this.textContent='Following'">Follow</button><script>window.targetClicks=0</script>`);
  await follow(page,new AbortController().signal);
  assert.equal(await page.evaluate(()=>window.targetClicks),1);
  findings.push({case:'unrelated-following-button',observed:'Unrelated Following does not suppress target click'});
  const {ensureLogin}=require(path.join(root,'src/main/workflows/login.ts'));
  await page.route('**/*',route=>{
   if(route.request().url().includes('/passport/'))return route.fulfill({contentType:'application/json',body:JSON.stringify({message:'error',data:{}})});
   return route.fulfill({contentType:'text/html',body:`<input name="username"><input type="password"><button data-e2e="login-button" onclick="document.body.innerHTML='<div>Enter code sent to your email</div><input name=code><button onclick=window.nextClicks++>Next</button>';window.nextClicks=0">Log in</button>`});
  });
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),4000);
  try{await ensureLogin(page,{id:'fixture',username:'fixture',password:'fake',email:'fixture@outlook.com'},{connected:async()=>true,waitForCode:async()=> '012345'},controller.signal,()=>{},()=>{})}catch(e){assert.match(e.message,/Đã dừng/)}finally{clearTimeout(timer)}
  assert.equal(await page.locator('input[name=code]').inputValue(),'012345');
  assert.equal(await page.evaluate(()=>window.nextClicks),1);
  findings.push({case:'otp-next-button',observed:'OTP filled and Next clicked once'});
  const {KeyedQueue}=require(path.join(root,'src/main/workflows/control.ts'));
  const gates=new KeyedQueue(); let active=0,peak=0;
  await Promise.all([1,2,3].map(()=>gates.run('same-mail',new AbortController().signal,async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--})));
  assert.equal(peak,1); findings.push({case:'shared-email',observed:'Three concurrent callers serialized'});
  const {fillCode,automateMicrosoft}=require(path.join(root,'src/main/workflows/login.ts'));
  await page.unroute('**/*');
  await page.setContent('<div role="dialog">'+Array.from({length:6},()=>'<input maxlength="1">').join('')+'<button onclick="window.confirmed=true">Confirm</button></div>');
  await fillCode(page,'123456',new AbortController().signal);
  assert.deepEqual(await page.locator('input').evaluateAll(nodes=>nodes.map(n=>n.value)),['1','2','3','4','5','6']);assert.equal(await page.evaluate(()=>window.confirmed),true);
  findings.push({case:'segmented-otp',observed:'Each digit filled independently and scoped Confirm clicked'});
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<span id="displayName">wrong@outlook.com</span><input name="passwd" type="password"><button type="submit">Sign in</button>'}));
  const gate=new AbortController(),stop=setTimeout(()=>gate.abort(),1000);
  try{await automateMicrosoft(page,{email:'expected@outlook.com',passMail:'fixture-password'},'ABCD','https://login.live.com/login',gate.signal,()=>{});assert.fail('Must wait for correct mailbox')}catch(e){assert.match(e.message,/Đã dừng/)}finally{clearTimeout(stop)}
  assert.equal(await page.locator('input[name=passwd]').inputValue(),'');findings.push({case:'microsoft-wrong-mailbox',observed:'Password not filled into another mailbox'});
 }finally{await browser.close()}
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({date:new Date().toISOString(),regressionChecks:true,findings},null,2));
 console.log(JSON.stringify(findings,null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
