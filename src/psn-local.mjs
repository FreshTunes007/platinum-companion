import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import * as sdk from 'psn-api';
import { PSNClient, ProviderError, installReadOnlyTransport } from './provider.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dataDir = fileURLToPath(new URL('../private/',import.meta.url));
const checkpoint = JSON.parse(await readFile(new URL('../docs/psn-spike-status.json',import.meta.url),'utf8'));
if (checkpoint.directAuthState === 'BLOCKED_EXTERNAL') {
  console.log('Sony web-auth временно заблокирован. Используется сохранённый снимок; повторный вход сейчас не выполняется.');
  process.exit(0);
}
await mkdir(dataDir,{recursive:true});
const transport = installReadOnlyTransport();
const csrf = randomBytes(24).toString('hex');
let provider, games=[], busy=false, lastAuth=0;
const port = Number(process.env.PLATINUM_PORT ?? 43127);
const origin = `http://127.0.0.1:${port}`;
async function save(name,data) {
  const target = `${dataDir}/${name}.json`;
  await writeFile(`${target}.tmp`,JSON.stringify(data,null,2)); await rename(`${target}.tmp`,target);
}
const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Platinum Companion — PSN</title><style>body{font:17px system-ui;background:#101820;color:#edf4fa;max-width:720px;margin:6vh auto;padding:24px}a{color:#91caff}input,button,select{font:inherit;padding:12px;margin:8px 0;width:100%;box-sizing:border-box}button{cursor:pointer}pre{white-space:pre-wrap}small{color:#b7c8d4}</style><h1>Подключить PSN</h1><p>Техническая проверка · The Witcher 3 · PS5</p><ol><li>Войдите в свой разрешённый тестовый аккаунт на <a target="_blank" rel="noreferrer" href="https://www.playstation.com/">PlayStation</a>.</li><li>В том же браузере откройте <a target="_blank" rel="noreferrer" href="https://ca.account.sony.com/api/v1/ssocookie">страницу Sony</a> и скопируйте значение npsso (без кавычек).</li><li>Вставьте его ниже. Пароль здесь не нужен.</li></ol><form id="auth"><input id="secret" type="password" autocomplete="off" spellcheck="false" placeholder="NPSSO · 64 символа" minlength="64" maxlength="64" required><button>Подключить и найти Ведьмака</button></form><small>Секрет отправляется только локальному процессу и Sony для авторизации; на диск и в чат не записывается. Нормализованные трофеи сохраняются локально. Проверка только читает PSN; настройки и трофеи не изменяет.</small><form id="sync" hidden><select id="game"></select><button>Загрузить трофеи выбранной версии</button></form><button id="refresh" hidden>Проверить обновление авторизации</button><pre id="status">Ожидает подключения.</pre><script nonce="${csrf}">
const token=location.hash.slice(1); history.replaceState(null,'',location.pathname); const status=document.querySelector('#status');
async function call(path,data){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Platinum-Token':token},body:JSON.stringify(data)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;}
document.querySelector('#auth').onsubmit=async e=>{e.preventDefault();let npsso=document.querySelector('#secret').value.trim();document.querySelector('#secret').value='';status.textContent='Подключение…';try{const result=await call('/auth',{npsso});npsso='';const sel=document.querySelector('#game');sel.replaceChildren();for(const g of result.games){const o=document.createElement('option');o.value=g.setId;o.textContent=g.title+' · '+g.platform+' · '+g.setId;sel.append(o);}document.querySelector('#sync').hidden=!result.games.length;document.querySelector('#refresh').hidden=false;status.textContent=result.games.length?'Аккаунт подключён. Выберите набор и загрузите трофеи.':'В списке аккаунта не найден Ведьмак. Возможно, игра ещё не синхронизирована с PSN.';}catch(e){status.textContent='Не удалось подключить: '+e.message;}finally{npsso='';}};
document.querySelector('#sync').onsubmit=async e=>{e.preventDefault();status.textContent='Загрузка полного каталога и прогресса…';try{const r=await call('/sync',{setId:document.querySelector('#game').value});status.textContent=JSON.stringify(r,null,2);}catch(e){status.textContent='Ошибка: '+e.message+' Последний успешный снимок сохранён.';}};
document.querySelector('#refresh').onclick=async()=>{try{status.textContent=JSON.stringify(await call('/refresh',{}),null,2);}catch(e){status.textContent='Ошибка: '+e.message;}};
</script></html>`;
const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${csrf}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
  if(req.headers.host!==`127.0.0.1:${port}`){res.writeHead(403);return res.end();}
  if(req.method==='GET'&&req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(html);}
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(req.method!=='POST'||req.headers.origin!==origin||req.headers['x-platinum-token']!==csrf){res.writeHead(403);return res.end('{"error":"local_access_required"}');}
  if(busy){res.writeHead(409);return res.end('{"error":"already_running"}');}busy=true;
  try{
    let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)throw new ProviderError('request_too_large');}
    const data=JSON.parse(body);
    if(req.url==='/auth'){
      if(Date.now()-lastAuth<30000)throw new ProviderError('auth_cooldown');lastAuth=Date.now();
      const candidate=new PSNClient(sdk);await candidate.authenticate(data.npsso);data.npsso='';body='';
      const listed=await candidate.listGames();provider=candidate;games=listed.items;
      await save('connection-status',{accountKey:provider.accountKey,games:games.length,pages:listed.pages,sync:provider.getSyncStatus()});
      res.end(JSON.stringify({games:games.filter(g=>/witcher|ведьмак/i.test(g.title))}));
    }else if(req.url==='/sync'){
      const game=games.find(g=>g.setId===data.setId);if(!provider||!game)throw new ProviderError('select_listed_game');
      const snapshot=await provider.sync(game);await save(`psn-${provider.accountKey}-${game.setId}`,snapshot);await save('latest-psn',snapshot);
      await save('connection-status',{accountKey:provider.accountKey,sync:provider.getSyncStatus(),requests:transport.count()});
      res.end(JSON.stringify({result:'Реальные данные PSN сохранены',set:game,version:snapshot.set.version,trophies:snapshot.account.trophies.length,earned:snapshot.account.trophies.filter(t=>t.earned).length,groups:snapshot.set.groups.length,pages:{catalog:snapshot.set.pages,earned:snapshot.account.pages},sync:provider.getSyncStatus()},null,2));
    }else if(req.url==='/refresh'){
      if(!provider)throw new ProviderError('not_connected');await provider.refresh();
      await save('connection-status',{accountKey:provider.accountKey,sync:provider.getSyncStatus(),requests:transport.count()});res.end(JSON.stringify({result:'Refresh выполнен',sync:provider.getSyncStatus()}));
    }else{res.writeHead(404);res.end('{"error":"not_found"}');}
  }catch(e){const code=e instanceof ProviderError?e.code:'local_or_upstream_error';await save('last-error',{code,at:new Date().toISOString(),sync:provider?.getSyncStatus()??null});res.writeHead(400);res.end(JSON.stringify({error:code}));}finally{busy=false;}
});
server.listen(port,'127.0.0.1',()=>console.log(`LOCAL_AUTH_URL=${origin}/#${csrf}`));
