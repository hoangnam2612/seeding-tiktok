const assert = require('assert/strict'), fs = require('fs'), path = require('path'), Module = require('module');
const output = path.resolve('tmp/native-engine-checks', String(Date.now())); fs.mkdirSync(output, {recursive:true});
const original = Module._load;
const packaged = process.argv.includes('--packaged');
if (packaged) Object.defineProperty(process, 'resourcesPath', {value:path.resolve('release/win-unpacked/resources')});
Module._load = function(id,...args) { if(id==='electron')return {app:{isPackaged:packaged},screen:{}};return original.call(this,id,...args); };
const {NativeWorkflowService} = require('../dist/main/workflows/native-service');
const {browserDefaults,defaults} = require('../dist/main/workflows/contracts');
const events=[],updates=[];
const service = new NativeWorkflowService(output,{emit:e=>events.push(e),update:(id,patch)=>updates.push({id,patch})});
const timer=setTimeout(()=>{console.error('Native engine check timed out');void service.shutdown().catch(console.error);process.exitCode=1},30000);
(async()=>{
 try {
  const hello=await service.request('hello');assert.equal(hello.engine,'csharp');assert.equal(hello.commands.length,6);
  const empty=await service.run('login',[],{},browserDefaults);assert.equal(empty.success,true);
  const accounts=[{id:'external-fixture',username:'fixture',displayName:'Fixture',status:'unauthenticated',categoryId:'category-fixture',followerCount:12,followingCount:3,likesCount:20}];
  const result=await service.run('upload',accounts,{...defaults.upload,videos:[{path:path.join(output,'missing.mp4'),title:'Fixture',description:'Fixture',size:'0'},{path:path.join(output,'second-missing.mp4'),title:'Second',description:'',size:'0'}]},browserDefaults);
  assert.equal(result.success,false);assert.equal(result.failures,1);assert.equal(result.remaining,1);
  assert.equal(events.filter(e=>e.type==='item').length,1);assert.equal(events[0].accountId,'external-fixture');
  assert.equal(updates[0].id,'external-fixture');assert.equal(updates[0].patch.lastAction,'upload');assert.match(updates[0].patch.message,/Không tìm thấy file/);
  const ids=JSON.parse(fs.readFileSync(path.join(output,'engine-ids.json'),'utf8'));assert.equal(ids['external-fixture'],1);
  await service.browsers.close(['external-fixture']);await service.cancel();
  await assert.rejects(service.request('unknown'),/không hợp lệ/);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({success:true,engine:hello,checks:['native handshake','empty run','upload failure and remaining queue','external ID and account patch','close and cancel','unknown command rejected']},null,2));
  console.log('PASS actual C# engine handshake, routing, queue, account sync, close/cancel. No real account/network actions.');
 } finally {clearTimeout(timer);await service.shutdown();}
})().catch(error=>{console.error(error);process.exitCode=1});
