const {BrowserWindow,WebContentsView,session,ipcMain,app}=require('electron');
const path=require('node:path');const {pathToFileURL}=require('node:url');const oauth=require('./oauth.cjs');
const toolbarFile=path.join(__dirname,'auth-toolbar.html'),toolbarUrl=pathToFileURL(toolbarFile).href;
const domains={yandex:['yandex.ru','yandex.net','ya.ru'],soundcloud:['soundcloud.com']};
function trustedHost(value,source){try{const u=new URL(value);return u.protocol==='https:'&&domains[source]?.some(h=>u.hostname===h||u.hostname.endsWith('.'+h))}catch{return false}}
function authHeader(headers){const entry=Object.entries(headers||{}).find(([k])=>k.toLowerCase()==='authorization');const value=Array.isArray(entry?.[1])?entry[1][0]:entry?.[1];const m=/^(?:OAuth|Bearer)\s+([A-Za-z0-9_.~-]{8,})$/i.exec(String(value||''));return m?.[1]||null}
function soundcloudCookies(cookies){return (cookies||[]).filter(c=>/(^|\.)soundcloud\.com$/i.test(String(c.domain||'').replace(/^\./,''))&&['oauth_token','oauth_refresh_token'].includes(c.name)&&typeof c.value==='string'&&c.value.length>8).map(({name,value,domain})=>({name,value,domain}))}
module.exports=function(mainWindow,port,uiPort=port){
 const contexts=new Map();
 const trustedMain=e=>e.sender===mainWindow.webContents&&e.senderFrame?.routingId===mainWindow.webContents.mainFrame.routingId&&e.senderFrame?.processId===mainWindow.webContents.mainFrame.processId&&e.senderFrame.url.startsWith(`http://127.0.0.1:${uiPort}/`);
 const notify=(source,state)=>{if(!mainWindow.isDestroyed())mainWindow.webContents.send('auth:progress',{source,...state})};
 async function open(source){const old=contexts.get(source);if(old&&!old.win.isDestroyed()){old.win.show();old.win.focus();return {ok:false,error:'already_open',message:'Окно входа уже открыто. Перезагрузи страницу или нажми «Я вошёл — проверить».'}}
  const sourceSession=session.fromPartition('persist:soulroom-'+source);
  let resolve;const result=new Promise(r=>resolve=r);
  const c={source,session:sourceSession,done:false,saving:false,lastToken:'',status:'Войди в аккаунт. После входа нажми «Я вошёл — проверить».',resolve,popups:new Set()};
  const area=require('electron').screen.getPrimaryDisplay().workAreaSize;
  c.win=new BrowserWindow({width:Math.min(1120,area.width-60),height:Math.min(850,area.height-60),minWidth:700,minHeight:500,parent:mainWindow,modal:false,show:false,title:'soulroom · '+(source==='yandex'?'Вход в Яндекс.Музыку':'Вход в SoundCloud'),autoHideMenuBar:true,backgroundColor:'#151b17',webPreferences:{preload:path.join(__dirname,'auth-controls.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
  c.view=new WebContentsView({webPreferences:{session:sourceSession,contextIsolation:true,sandbox:true,nodeIntegration:false}});c.win.contentView.addChildView(c.view);
  const remote=c.view.webContents;remote.setAudioMuted(true);
  const ua=app.userAgentFallback.replace(/\s(?:Electron|soulroom)\/[^\s]+/gi,'');remote.setUserAgent(ua);
  c.home=source==='yandex'?oauth.buildAuthUrl(oauth.OAUTH_CLIENTS[0].id):'https://soundcloud.com/signin';
  contexts.set(source,c);
  const update=(text,extra={})=>{c.status=text;const data={source,text,...extra};if(!c.win.isDestroyed())c.win.webContents.send('auth-window:state',data);notify(source,{stage:c.saving?'saving':'waiting',message:text})};c.update=update;
  let directRetry = false;
  remote.on('did-fail-load', async (_event, code, _description, url, mainFrame) => {
    if (source !== 'yandex' || !mainFrame || directRetry || ![-130,-111,-118,-101,-102,-105,-109].includes(code) || !trustedHost(url,source)) return;
    directRetry = true;
    try { await sourceSession.setProxy({mode:'direct'}); if (!remote.isDestroyed()) await remote.loadURL(url); } catch {}
  });
  const cleanup=()=>{clearInterval(c.poller);sourceSession.cookies.removeListener('changed',c.onCookie);sourceSession.webRequest.onBeforeSendHeaders(null);try{if(!remote.isDestroyed())remote.close()}catch{}for(const p of c.popups)if(!p.isDestroyed())p.close();contexts.delete(source)};

  async function verify(){
   if(c.verifying)return {ok:false,pending:true};c.verifying=true;
   update('Сессия сохранена. Проверяем именно доступ к аккаунту…');
   try{const r=await fetch(`http://127.0.0.1:${port}/api/status?force=1`,{signal:AbortSignal.timeout(22000)});if(!r.ok)throw Error('status');const d=await r.json(),s=d.sources?.[source];
    c.verified=!!s?.connected&&(source!=='soundcloud'||s.accountConnected===true);
    const message=c.verified?'Аккаунт подключён. Можно закрыть это окно.':s?.pending?'Сессия сохранена, но проверка не завершилась из-за сети. Нажми «Я вошёл — проверить» ещё раз.':'Сервис не подтвердил доступ к аккаунту. Заверши вход или попробуй другой способ входа.';
    update(message);notify(source,{stage:c.verified?'connected':'error',message});return {ok:c.verified,saved:true,message};
   }catch{const message='Сессия сохранена, но сервис пока не ответил. Окно остаётся открытым: повтори проверку.';update(message);notify(source,{stage:'error',message});return {ok:false,saved:true,pending:true,message}}finally{c.verifying=false}
  }
  async function save(token,cookies){if(c.done||c.saving||!token||token===c.lastToken)return false;c.saving=true;update('Сессия получена. Сохраняем подключение…');try{const payload=source==='yandex'?{source,token}:{source,cookies:JSON.stringify(cookies)};const r=await fetch(`http://127.0.0.1:${port}/api/auth/session`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)});const d=await r.json();if(!r.ok||!d.saved)throw Error('save');c.lastToken=token;const result=await verify();resolve(result);if(!mainWindow.isDestroyed())mainWindow.webContents.send('auth:changed',{source,saved:true});return true}catch{update('Не удалось сохранить сессию. Нажми «Я вошёл — проверить» ещё раз.');notify(source,{stage:'error',message:'Не удалось сохранить сессию'});return false}finally{c.saving=false}}
  c.check=async(manual=false)=>{if(c.done||c.saving||c.verifying)return {ok:false,pending:true};if(!c.lastToken)update('Проверяем сессию открытого окна…');try{const url=remote.getURL();if(source==='yandex'&&trustedHost(url,source)){const error=oauth.extractError(url);if(error){update(oauth.describeError(error));return {ok:false,pending:true}}const token=oauth.extractToken(url);if(token&&await save(token))return {ok:!!c.verified,saved:true}}
    if(source==='soundcloud'){const cookies=soundcloudCookies(await sourceSession.cookies.get({})),token=cookies.find(x=>x.name==='oauth_token')?.value;if(token&&await save(token,cookies))return {ok:true}}
    if(c.lastToken)return manual?verify():{ok:!!c.verified,saved:true};update('Пока не получили данные входа. Заверши вход, затем обнови страницу или нажми «Я вошёл — проверить».');return {ok:false,pending:true}
   }catch{update('Не удалось прочитать сессию. Обнови страницу входа и попробуй снова.');return {ok:false,pending:true}}};
  sourceSession.webRequest.onBeforeSendHeaders({urls:['https://api.music.yandex.net/*','https://api.music.yandex.ru/*']},(details,callback)=>{callback({requestHeaders:details.requestHeaders});if(source!=='yandex'||!trustedHost(details.url,source))return;const token=oauth.tokenFromAuthorizationHeader(Object.entries(details.requestHeaders).find(([k])=>k.toLowerCase()==='authorization')?.[1]);if(token)save(token)});
  c.onCookie=(_event,cookie)=>{if(source==='soundcloud'&&soundcloudCookies([cookie]).length)c.check()};sourceSession.cookies.on('changed',c.onCookie);
  const consider=(_e,url)=>{if(source==='yandex'&&trustedHost(url,source)){const token=oauth.extractToken(url);if(token)save(token)}};
  remote.on('will-navigate',consider);remote.on('will-redirect',consider);remote.on('did-navigate-in-page',()=>c.check());remote.on('did-finish-load',()=>{if(!c.lastToken&&!c.saving)update('Страница загружена. Войди в аккаунт или нажми «Я вошёл — проверить».');c.check()});remote.on('did-fail-load',(_e,code)=>{if(code!==-3&&!c.lastToken)update('Страница сервиса не загрузилась. Проверь сеть и нажми «Обновить».')});
  remote.setWindowOpenHandler(({url})=>/^https:\/\//i.test(url)?{action:'allow',overrideBrowserWindowOptions:{webPreferences:{session:sourceSession,contextIsolation:true,sandbox:true,nodeIntegration:false}}}:{action:'deny'});remote.on('did-create-window',popup=>{c.popups.add(popup);popup.webContents.setAudioMuted(true);popup.on('closed',()=>{c.popups.delete(popup);c.check()})});
  const resize=()=>{if(c.win.isDestroyed())return;const [width,height]=c.win.getContentSize();c.view.setBounds({x:0,y:104,width,height:Math.max(0,height-104)})};c.win.on('resize',resize);resize();c.win.on('closed',()=>{if(!c.done){c.done=true;cleanup();resolve({ok:false,canceled:true,message:'Окно входа закрыто. Сохранённая сессия не очищалась.'})}});
  c.win.webContents.on('did-finish-load',()=>update(c.status));await c.win.loadFile(toolbarFile);c.win.show();remote.loadURL(c.home).catch(()=>update('Не удалось открыть сервис. Нажми «Обновить».'));c.poller=setInterval(()=>c.check(),3000);return result;
 }
 for(const source of ['yandex','soundcloud'])ipcMain.handle('auth:'+source,e=>trustedMain(e)?open(source):{ok:false,message:'Недопустимый источник запроса'});
 ipcMain.handle('auth:recheck',async(e,source)=>{if(!trustedMain(e))return {ok:false};const c=contexts.get(source);if(c)return c.check(true);return {ok:false,pending:true,message:'Открой окно входа сервиса, затем нажми «Я вошёл — проверить».'}});
 ipcMain.handle('auth-window:action',async(e,action)=>{const c=[...contexts.values()].find(c=>e.sender===c.win.webContents&&!c.win.isDestroyed()&&e.senderFrame?.url===toolbarUrl&&e.senderFrame.routingId===c.win.webContents.mainFrame.routingId);if(!c)return {ok:false};const remote=c.view.webContents;if(action==='check')return c.check(true);if(action==='reload'){remote.reloadIgnoringCache();c.update('Обновляем страницу…')}else if(action==='back'&&remote.canGoBack())remote.goBack();else if(action==='home')remote.loadURL(c.source==='yandex'?'https://music.yandex.ru/':c.home);else if(action==='oauth'&&c.source==='yandex')remote.loadURL(oauth.buildAuthUrl(oauth.OAUTH_CLIENTS[0].id));else if(action==='close')c.win.close();return {ok:true}});
};
module.exports._test={trustedHost,authHeader,soundcloudCookies};
