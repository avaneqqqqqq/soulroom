const {app,BrowserWindow,shell,ipcMain,screen}=require('electron');
const {spawn}=require('node:child_process');
const path=require('node:path');
let server,mainWindow;
app.setName('soulroom');
const profilePath=app.commandLine.getSwitchValue('user-data-dir')||path.join(app.getPath('appData'),'soulroom');require('node:fs').mkdirSync(profilePath,{recursive:true});app.setPath('userData',profilePath);
if(!app.requestSingleInstanceLock())app.quit();else{
app.on('second-instance',()=>{if(mainWindow){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus()}});
app.whenReady().then(async()=>{
const uiPort=Number(process.env.SOULROOM_PORT)||5288,origin=`http://127.0.0.1:${uiPort}`;
const dataDir=process.env.PLAYER_DATA_DIR||path.join(app.getPath('userData'),'data'),fs=require('node:fs');
if(!process.env.PLAYER_DATA_DIR&&!fs.existsSync(path.join(dataDir,'settings.json'))&&fs.existsSync(path.join(__dirname,'data/settings.json'))){fs.mkdirSync(dataDir,{recursive:true});const raw=fs.readFileSync(path.join(__dirname,'data/settings.json'),'utf8');JSON.parse(raw);fs.writeFileSync(path.join(dataDir,'settings.json'),raw,{mode:0o600});fs.writeFileSync(path.join(dataDir,'settings.json.backup'),raw,{mode:0o600})}
server=spawn(process.execPath,[path.join(__dirname,'server/index.mjs')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',PORT:String(uiPort),PLAYER_VERSION:app.isPackaged?app.getVersion():require('./package.json').version,PLAYER_DATA_DIR:dataDir},windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
const port = await new Promise(resolve => {
  const timer = setTimeout(() => finish(0), 20000);
  function finish(value) {
    clearTimeout(timer);
    server.off('message', onMessage);
    resolve(value);
  }
  function onMessage(message) {
    if (message?.type === 'listening' && Number.isInteger(message.port) && message.port > 0 && message.port <= 65535) finish(message.port);
  }
  server.on('message', onMessage);
  server.once('error', () => finish(0));
  server.once('exit', () => { finish(0); app.quit(); });
});
if (!port) {
  require('electron').dialog.showErrorBox('Не удалось открыть soulroom', 'Локальный сервер завершился до запуска интерфейса. Подробности в журнале soulroom/data/server.log.');
  app.quit();
  return;
}
const backendOrigin = 'http://127.0.0.1:' + port;
if (port !== uiPort) {
  const {session, net} = require('electron');
  const forward = require('./desktop-loopback.cjs');
  session.defaultSession.protocol.handle('http', request => {
    if (new URL(request.url).origin === origin) return forward(request, origin, backendOrigin);
    return net.fetch(request, {bypassCustomProtocolHandlers: true});
  });
}
const area=screen.getPrimaryDisplay().workAreaSize;
const win=new BrowserWindow({width:Math.min(1600,area.width-80),height:Math.min(1040,area.height-80),minWidth:760,minHeight:600,show:false,backgroundColor:'#151716',autoHideMenuBar:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,preload:path.join(__dirname,'preload.cjs')}});
mainWindow=win;
win.webContents.setWindowOpenHandler(({url})=>{if(/^https?:/.test(url))shell.openExternal(url);return {action:'deny'}});
win.webContents.on('will-navigate',(e,url)=>{if(!url.startsWith(origin+'/'))e.preventDefault()});
require('./desktop-auth.cjs')(win,port,uiPort);
require('./desktop-update.cjs')(win,uiPort);
ipcMain.handle('auth:spotify',async(event,clientId)=>{if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||!event.senderFrame.url.startsWith(origin+'/'))return {ok:false};const r=await fetch(backendOrigin+'/api/spotify/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId})});const d=await r.json();if(!r.ok)return {ok:false,message:d.error?.message};if(new URL(d.url).origin!=='https://accounts.spotify.com')return {ok:false};await shell.openExternal(d.url);return {ok:true,redirectUri:d.redirectUri}});
ipcMain.handle('window:fullscreen',(event,enabled)=>{if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||!event.senderFrame.url.startsWith(origin+'/'))return false;win.setFullScreen(enabled===true);return enabled===true});
win.once('ready-to-show',()=>win.show());
win.loadURL(origin);
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>server?.kill());
}
