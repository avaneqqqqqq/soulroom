const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),pkg=require('../package.json'),repo='avaneqqqqqq/soulroom',tag='v'+pkg.version;
if(process.env.GITHUB_REF_TYPE==='tag'&&process.env.GITHUB_REF_NAME!==tag)throw Error('Tag does not match package version');
execFileSync(process.execPath,[require.resolve('electron-builder/cli.js'),'--win','nsis','--x64','--publish','never'],{cwd:root,stdio:'inherit',windowsHide:true});
const names=[`soulroom-${pkg.version}-setup.exe`,`soulroom-${pkg.version}-setup.exe.blockmap`,'latest.yml'],files=names.map(n=>path.join(root,'release',n));
for(const f of files)if(!fs.existsSync(f)||!fs.statSync(f).size)throw Error('Missing release artifact: '+path.basename(f));
const manifest=fs.readFileSync(files[2],'utf8'),expected=/^sha512:\s*(\S+)/m.exec(manifest)?.[1],actual=crypto.createHash('sha512').update(fs.readFileSync(files[0])).digest('base64');
if(!manifest.includes('version: '+pkg.version)||!manifest.includes('path: '+names[0])||expected!==actual||fs.statSync(files[0]).size<10*1024*1024)throw Error('Release integrity validation failed');
const gh=args=>execFileSync('gh',[...args,'--repo',repo],{cwd:root,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
let release;try{release=JSON.parse(gh(['release','view',tag,'--json','isDraft,assets']))}catch(e){if(!/not found|could not resolve|HTTP 404/i.test(String(e.stderr||'')))throw e}
if(release&&!release.isDraft){console.log('Published release is immutable; artifacts left unchanged.');process.exit(0)}
if(!release)gh(['release','create',tag,'--verify-tag','--draft','--title','soulroom '+pkg.version,'--notes-file','RELEASE_NOTES.md']);
gh(['release','upload',tag,...files,'--clobber']);
release=JSON.parse(gh(['release','view',tag,'--json','assets']));
for(let i=0;i<names.length;i++)if(!release.assets.some(a=>a.name===names[i]&&a.size===fs.statSync(files[i]).size))throw Error('GitHub asset verification failed: '+names[i]);
if(process.env.SOULROOM_PUBLISH==='1')gh(['release','edit',tag,'--draft=false','--latest','--notes-file','RELEASE_NOTES.md']);
console.log(`https://github.com/${repo}/releases/tag/${tag}`);
