const {app}=require('electron');const fs=require('node:fs'),path=require('node:path');
app.setPath('userData',path.join(process.env.APPDATA,'electron-nest-react'));
app.whenReady().then(async()=>{
 const root=path.join(app.getPath('userData'),'data');
 const accounts=JSON.parse(fs.readFileSync(path.join(root,'accounts.json'),'utf8'));
 for(const account of accounts)for(const key of ['cookie','password','email','passMail','twoFactor','proxy','token','recoveryMail']){account[key]=require('../dist/main/secret-json').decryptSecret(account[key]);if(account[key].startsWith('enc:v1:'))throw new Error('Cannot decrypt');}
 const events=[];
 const service=new (require('../dist/main/workflows/service').WorkflowService)(path.join(root,'workflows'),{emit:event=>{events.push(event);console.log(JSON.stringify(event));},update:()=>{}});
 const settings=JSON.parse(fs.readFileSync(path.join(root,'workflows/settings.json'),'utf8'));
 const result=await service.run('video',accounts,{...require('../dist/main/workflows/contracts').defaults.video,videoUrls:['https://www.tiktok.com/@phung_an02/video/7655347871339924743?is_from_webapp=1&sender_device=pc'],minViewSeconds:5,maxViewSeconds:5,isLike:false,isComment:false,isFollow:false,isFavorite:false},settings);
 console.log(JSON.stringify(result));fs.writeFileSync('tmp/account-navigation/workflow-report.json',JSON.stringify({result,events},null,2));app.exit(result.success?0:1);
}).catch(e=>{console.error(e.message);app.exit(1)});
