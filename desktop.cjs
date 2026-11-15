const {app,BrowserWindow,shell,ipcMain,screen}=require('electron');
const {spawn}=require('node:child_process');
const path=require('node:path');
let server,mainWindow;
app.setName('soulroom');
const profilePath=app.commandLine.getSwitchValue('user-data-dir')||path.join(app.getPath('appData'),'soulroom');require('node:fs').mkdirSync(profilePath,{recursive:true});app.setPath('userData',profilePath);
if(!app.requestSingleInstanceLock())app.quit();else{
app.on('second-instance',()=>{if(mainWindow){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus()}});
app.whenReady().then(async()=>{
const port=Number(process.env.SOULROOM_PORT)||5288,origin=`http://127.0.0.1:${port}`;
const dataDir=process.env.PLAYER_DATA_DIR||path.join(app.getPath('userData'),'data'),fs=require('node:fs');
if(!process.env.PLAYER_DATA_DIR&&!fs.existsSync(path.join(dataDir,'settings.json'))&&fs.existsSync(path.join(__dirname,'data/settings.json'))){fs.mkdirSync(dataDir,{recursive:true});const raw=fs.readFileSync(path.join(__dirname,'data/settings.json'),'utf8');JSON.parse(raw);fs.writeFileSync(path.join(dataDir,'settings.json'),raw,{mode:0o600});fs.writeFileSync(path.join(dataDir,'settings.json.backup'),raw,{mode:0o600})}
server=spawn(process.execPath,[path.join(__dirname,'server/index.mjs')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',PORT:String(port),PLAYER_VERSION:app.isPackaged?app.getVersion():require('./package.json').version,PLAYER_DATA_DIR:dataDir},windowsHide:true,stdio:'ignore'});
let ready = false;
for (let attempt = 0; attempt < 60 && server.exitCode === null; attempt++) {
  try {
    const response = await fetch(origin + '/api/health', {signal: AbortSignal.timeout(500)});
    const health = await response.json();
    if (response.ok && health.pid === server.pid) {
      ready = true;
      break;
    }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 250));
}
if (!ready) {
  require('electron').dialog.showErrorBox('Не удалось открыть soulroom', 'Закрой предыдущий экземпляр плеера и запусти soulroom снова. Если проблема повторится, проверь, свободен ли порт ' + port + '.');
  app.quit();
  return;
}
const area=screen.getPrimaryDisplay().workAreaSize;
const win=new BrowserWindow({width:Math.min(1600,area.width-80),height:Math.min(1040,area.height-80),minWidth:760,minHeight:600,show:false,backgroundColor:'#151716',autoHideMenuBar:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,preload:path.join(__dirname,'preload.cjs')}});
mainWindow=win;
win.webContents.setWindowOpenHandler(({url})=>{if(/^https?:/.test(url))shell.openExternal(url);return {action:'deny'}});
win.webContents.on('will-navigate',(e,url)=>{if(!url.startsWith(origin+'/'))e.preventDefault()});
require('./desktop-auth.cjs')(win,port);
require('./desktop-update.cjs')(win,port);
ipcMain.handle('auth:spotify',async(event,clientId)=>{if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||!event.senderFrame.url.startsWith(origin+'/'))return {ok:false};const r=await fetch(origin+'/api/spotify/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId})});const d=await r.json();if(!r.ok)return {ok:false,message:d.error?.message};if(new URL(d.url).origin!=='https://accounts.spotify.com')return {ok:false};await shell.openExternal(d.url);return {ok:true,redirectUri:d.redirectUri}});
ipcMain.handle('window:fullscreen',(event,enabled)=>{if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||!event.senderFrame.url.startsWith(origin+'/'))return false;win.setFullScreen(enabled===true);return enabled===true});
win.once('ready-to-show',()=>win.show());
win.loadURL(origin);
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>server?.kill());
}
