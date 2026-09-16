const assert=require('assert/strict'),vm=require('vm'),fs=require('fs'),path=require('path');
async function scenario(owns,broken,packaged) {
 let windows=0,errors=0,quits=0,loaded='';
 const app={requestSingleInstanceLock:()=>owns,quit:()=>quits++,on:()=>{},whenReady:()=>Promise.resolve(),commandLine:{appendSwitch:()=>{}},isPackaged:packaged};
 class Window {constructor(){windows++;}loadURL(url){loaded=url;}loadFile(file){loaded=file;}once(){}on(){}static getAllWindows(){return [];}}
 const nest={enableCors(){},use(){},async listen(){if(broken)throw Error('fixture port busy');},get(){return {};}};
 const context={exports:{},__dirname:path.resolve('dist/main'),console:{log(){},error(){}},process:{env:{NODE_ENV:'development'},platform:'win32',versions:{},on(){}},require:id=>{
  if(id==='electron')return {app,BrowserWindow:Window,ipcMain:{handle(){}},dialog:{showErrorBox(){errors++;}}};
  if(id==='path')return path;
  if(id==='@nestjs/core')return {NestFactory:{create:async()=>nest}};
  if(id==='./workflows/ipc')return {setupWorkflowIPC(){}};
  return {};
 }};
 vm.runInNewContext(fs.readFileSync('dist/main/index.js','utf8'),context);
 await new Promise(resolve=>setImmediate(resolve));return {windows,errors,quits,loaded};
}
(async()=>{
 const failed=await scenario(true,true,true);assert.equal(failed.windows,0);assert.equal(failed.errors,1);assert.equal(failed.quits,1);
 const duplicate=await scenario(false,false,true);assert.equal(duplicate.windows,0);assert.equal(duplicate.quits,1);
 const packaged=await scenario(true,false,true);assert.equal(packaged.windows,1);assert(packaged.loaded.endsWith(path.join('renderer','index.html')));
 console.log('PASS startup: failed backend blocks UI; duplicate instance quits; packaged app ignores development environment.');
})().catch(error=>{console.error(error);process.exitCode=1});
