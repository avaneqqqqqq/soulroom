const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('playerDesktop',{
isDesktop:true,
updateStatus:()=>ipcRenderer.invoke('updates:status'),checkUpdate:()=>ipcRenderer.invoke('updates:check'),downloadUpdate:()=>ipcRenderer.invoke('updates:download'),installUpdate:()=>ipcRenderer.invoke('updates:install'),
onUpdateState:callback=>{const handler=(_e,data)=>callback(data);ipcRenderer.on('updates:state',handler);return ()=>ipcRenderer.removeListener('updates:state',handler)},
recheckAuth:source=>ipcRenderer.invoke('auth:recheck',source),
onAuthProgress:callback=>{const handler=(_e,data)=>callback(data);ipcRenderer.on('auth:progress',handler);return ()=>ipcRenderer.removeListener('auth:progress',handler)},
signInSpotify:clientId=>ipcRenderer.invoke('auth:spotify',clientId),
setFullscreen:enabled=>ipcRenderer.invoke('window:fullscreen',enabled===true),
signInYandex:()=>ipcRenderer.invoke('auth:yandex'),
signInSoundCloud:()=>ipcRenderer.invoke('auth:soundcloud'),
onAuthChanged:callback=>{const handler=(_e,data)=>callback(data);ipcRenderer.on('auth:changed',handler);return ()=>ipcRenderer.removeListener('auth:changed',handler)}
});
