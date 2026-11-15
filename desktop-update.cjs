const {app,ipcMain}=require('electron');
module.exports=function(win,port,{updater=require('electron-updater').autoUpdater,packaged=app.isPackaged}={}){
 let state={stage:packaged?'idle':'development',current:app.getVersion(),version:null,percent:0,message:packaged?'':'Обновления устанавливаются в собранной версии приложения.'},checking=null,downloading=null;
 const notify=patch=>{state={...state,...patch};if(!win.isDestroyed())win.webContents.send('updates:state',state);return state};
 const trusted=e=>e.sender===win.webContents&&e.senderFrame?.routingId===win.webContents.mainFrame.routingId&&e.senderFrame?.processId===win.webContents.mainFrame.processId&&e.senderFrame.url.startsWith(`http://127.0.0.1:${port}/`);
 updater.autoDownload=false;updater.autoInstallOnAppQuit=false;updater.allowPrerelease=false;updater.allowDowngrade=false;
 updater.on('checking-for-update',()=>notify({stage:'checking',message:'Проверяем новую версию…'}));
 updater.on('update-available',info=>notify({stage:'available',version:info.version,percent:0,message:'Доступна новая версия soulroom'}));
 updater.on('update-not-available',()=>notify({stage:'current',message:'Установлена актуальная версия'}));
 updater.on('download-progress',p=>notify({stage:'downloading',percent:Math.max(0,Math.min(100,Number(p.percent)||0)),transferred:p.transferred,total:p.total,message:'Загружаем обновление из GitHub…'}));
 updater.on('update-downloaded',info=>notify({stage:'downloaded',version:info.version,percent:100,message:'Обновление загружено и проверено. Можно установить.'}));
 updater.on('error',()=>notify({stage:'error',message:'Не удалось получить обновление. Проверь соединение с GitHub и повтори.'}));
 async function check(){if(!packaged)return state;if(['downloading','downloaded','installing'].includes(state.stage))return state;if(!checking)checking=updater.checkForUpdates().catch(()=>notify({stage:'error',message:'GitHub пока не ответил. Проверку можно повторить.'})).finally(()=>checking=null);await checking;return state}
 ipcMain.handle('updates:status',e=>trusted(e)?state:{stage:'error',message:'Недопустимый запрос'});
 ipcMain.handle('updates:check',e=>trusted(e)?check():{stage:'error'});
 ipcMain.handle('updates:download',async e=>{if(!trusted(e)||!packaged)return {stage:'error'};if(downloading)return state;if(!['available','error'].includes(state.stage)||!state.version)return state;notify({stage:'downloading',percent:0,message:'Начинаем загрузку…'});downloading=updater.downloadUpdate().catch(()=>notify({stage:'error',message:'Загрузка не завершена. Попробуй ещё раз.'})).finally(()=>downloading=null);await downloading;return state});
 ipcMain.handle('updates:install',e=>{if(!trusted(e)||!packaged||state.stage!=='downloaded')return {ok:false};notify({stage:'installing',message:'Перезапускаем для установки…'});setImmediate(()=>updater.quitAndInstall(false,true));return {ok:true}});
 const startup=setTimeout(check,8000),interval=setInterval(check,4*60*60*1000);startup.unref?.();interval.unref?.();win.on('closed',()=>{clearTimeout(startup);clearInterval(interval)});
};
