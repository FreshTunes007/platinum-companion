import { createHash } from 'node:crypto';

export class ProviderError extends Error {
  constructor(code, retryAfterMs = 0) { super(code); this.code = code; this.retryAfterMs = retryAfterMs; }
}
const invalid = () => { throw new ProviderError('schema_changed'); };
export function serviceFor(platform) {
  if (platform === 'PS5') return 'trophy2';
  if (['PS4', 'PS3', 'PSVITA'].includes(platform)) return 'trophy';
  throw new ProviderError('unsupported_platform');
}
export function installReadOnlyTransport({metadata=false}={}) {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const auth = u.hostname === 'ca.account.sony.com' && u.pathname.startsWith('/api/authz/v3/oauth/');
    const trophy = u.hostname === 'm.np.playstation.com' && u.pathname.startsWith('/api/trophy/');
    const catalog = metadata && u.hostname === 'm.np.playstation.com' && (/^\/api\/gamelist\/v2\/users\/me\/titles$/.test(u.pathname)||/^\/api\/catalog\/v2\/titles\/(?:PPSA|CUSA)\d{5}_00\/concepts$/.test(u.pathname));
    if (u.protocol !== 'https:' || !(auth || trophy || catalog) || (method !== 'GET' && !(auth && method === 'POST' && u.pathname.endsWith('/token')))) throw new ProviderError('request_not_allowed');
    requests++;
    let response;
    try { response = await original(input, { ...init, signal: AbortSignal.timeout(20000), redirect: 'manual' }); }
    catch { throw new ProviderError('network_or_timeout'); }
    if (response.status >= 400) {
      if(auth&&response.status===400){try{const body=await response.clone().json();if(body.error==='invalid_grant')throw new ProviderError('auth_reauth_required');}catch(e){if(e instanceof ProviderError)throw e;}}
      const retry = response.headers.get('retry-after');
      const ms = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now());
      const code = ({401:'auth_expired',403:'privacy_or_access_denied',404:'endpoint_or_title_missing',429:'rate_limited'})[response.status] ?? 'upstream_error';
      throw new ProviderError(code, Number.isFinite(ms) ? ms : 0);
    }
    return response;
  };
  return { count: () => requests, restore: () => { globalThis.fetch = original; } };
}

// Tokens are private process memory, never part of public provider state.
export class PSNClient {
  #sdk; #tokens; #expiresAt = 0; #clock; #sleep; #lastRequest = 0; #onTokenUpdate;
  constructor(sdk, { clock = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), gapMs = 800, onTokenUpdate=async()=>{}, snapshotCooldownMs=60000, retryAttempts=0, maxRetryWaitMs=30000 } = {}) {
    this.#sdk = sdk; this.#clock = clock; this.#sleep = sleep; this.gapMs = gapMs; this.#onTokenUpdate=onTokenUpdate;
    this.status = { provider:'psn', state:'not_connected', lastSuccessAt:null, error:null, nextAllowedAt:0, authExchanges:0, refreshes:0 };
    this.snapshotCooldownMs=snapshotCooldownMs;this.retryAttempts=retryAttempts;this.maxRetryWaitMs=maxRetryWaitMs;
  }
  async #setTokens(t) {
    if (!t?.accessToken || !t.refreshToken || !Number.isFinite(t.expiresIn)) throw new ProviderError('invalid_auth_response');
    this.#tokens = t; this.#expiresAt = this.#clock() + t.expiresIn * 1000;
    await this.#onTokenUpdate(t);
  }
  async authenticate(npsso) {
    if (typeof npsso !== 'string' || npsso.length !== 64) throw new ProviderError('invalid_npsso_format');
    const code = await this.#sdk.exchangeNpssoForAccessCode(npsso);
    await this.#setTokens(await this.#sdk.exchangeAccessCodeForAuthTokens(code));
    this.status.authExchanges++;
    const summary = await this.#call('getUserTrophyProfileSummary', 'me');
    if (typeof summary?.accountId !== 'string') invalid();
    this.accountKey = createHash('sha256').update(summary.accountId).digest('hex').slice(0,20);
    this.status.state = 'connected';
    return this.accountKey;
  }
  async refresh() {
    if (!this.#tokens) throw new ProviderError('not_connected');
    await this.#setTokens(await this.#sdk.exchangeRefreshTokenForAuthTokens(this.#tokens.refreshToken));
    this.status.refreshes++;
  }
  async authenticateWithRefreshToken(refreshToken){
    if(typeof refreshToken!=='string'||!refreshToken)throw new ProviderError('invalid_refresh_credential');
    await this.#setTokens(await this.#sdk.exchangeRefreshTokenForAuthTokens(refreshToken));this.status.refreshes++;
    const summary=await this.#call('getUserTrophyProfileSummary','me');
    if(typeof summary?.accountId!=='string')invalid();
    this.accountKey=createHash('sha256').update(summary.accountId).digest('hex').slice(0,20);
    this.status.state='connected';return this.accountKey;
  }
  async #call(name, ...args) {
    if (!this.#tokens) throw new ProviderError('not_connected');
    if (this.#clock() < this.status.nextAllowedAt) throw new ProviderError('cooldown');
    if (this.#clock() >= this.#expiresAt - 60000) await this.refresh();
    await this.#sleep(Math.max(0, this.gapMs - (this.#clock() - this.#lastRequest)));
    this.#lastRequest = this.#clock();
    try {
      let response;
      try {
        for(let attempt=0;;attempt++){
          try{response=await this.#sdk[name]({accessToken:this.#tokens.accessToken},...args);break;}
          catch(error){
            const wait=Math.max(error.retryAfterMs??0,1000*2**attempt);
            if(!['rate_limited','network_or_timeout','upstream_error'].includes(error.code)||attempt>=this.retryAttempts||wait>this.maxRetryWaitMs)throw error;
            await this.#sleep(wait);this.#lastRequest=this.#clock();
          }
        }
      }
      catch (e) {
        if (e.code !== 'auth_expired') throw e;
        await this.refresh();
        response = await this.#sdk[name]({accessToken:this.#tokens.accessToken}, ...args);
      }
      if (!response || response.error) invalid();
      return response;
    } catch (e) {
      const error = e instanceof ProviderError ? e : new ProviderError('upstream_or_schema_error');
      this.status.error = error.code; this.status.state = 'degraded';
      this.status.nextAllowedAt = this.#clock() + Math.max(error.retryAfterMs, error.code === 'rate_limited' ? 300000 : 30000);
      throw error;
    }
  }
  async #pages(name, args, key, options = {}) {
    const items = [], ids = new Set(); let offset = 0, total, version;
    for (let page = 0; page < 200; page++) {
      const r = await this.#call(name, ...args, { ...options, offset, limit:name === 'getUserTitles' ? 800 : 50 });
      if (!Array.isArray(r[key]) || !Number.isInteger(r.totalItemCount) || r.totalItemCount < 0) invalid();
      if (total !== undefined && total !== r.totalItemCount) throw new ProviderError('snapshot_changed_during_pagination');
      if (version !== undefined && version !== r.trophySetVersion) throw new ProviderError('catalog_changed_during_pagination');
      total = r.totalItemCount; version = r.trophySetVersion;
      for (const item of r[key]) {
        const id = key === 'trophyTitles' && typeof item.npCommunicationId==='string' && typeof item.trophyTitlePlatform==='string' ? `${item.npCommunicationId}:${item.trophyTitlePlatform}` : key==='trophyTitles'?undefined:item.trophyId;
        if (id === undefined || ids.has(id)) invalid();
        ids.add(id); items.push(item);
      }
      if (items.length === total) return {items, version, pages:page+1};
      if (items.length > total || !r[key].length || !Number.isInteger(r.nextOffset) || r.nextOffset <= offset) invalid();
      offset = r.nextOffset;
    }
    throw new ProviderError('pagination_limit');
  }
  async listGames() {
    const r = await this.#pages('getUserTitles', ['me'], 'trophyTitles');
    return { ...r, items:r.items.map(t => {
      if (typeof t.npCommunicationId !== 'string' || typeof t.trophyTitlePlatform !== 'string' || typeof t.trophyTitleName !== 'string') invalid();
      return {setId:t.npCommunicationId, title:t.trophyTitleName, platform:t.trophyTitlePlatform, progress:t.progress ?? null, iconUrl:t.trophyTitleIconUrl??null, definedTrophies:t.definedTrophies??null, earnedTrophies:t.earnedTrophies??null, lastUpdatedDateTime:t.lastUpdatedDateTime??null};
    }) };
  }
  playedTitlesPage(offset=0){return this.#call('getUserPlayedGames','me',{offset,limit:200,categories:'ps4_game,ps5_native_game'});}
  titleBindings(ids){if(!Array.isArray(ids)||ids.length<1||ids.length>5||ids.some(id=>! /^(PPSA|CUSA)\d{5}_00$/.test(id)))invalid();return this.#call('getUserTrophiesForSpecificTitle','me',{npTitleIds:ids.join(',')});}
  catalogConcept(titleId){if(! /^(PPSA|CUSA)\d{5}_00$/.test(titleId))invalid();return this.#call('getCatalogConcept',titleId);}
  async getTrophySet(game, language = 'en-US') {
    if (!['en-US','ru-RU'].includes(language)) throw new ProviderError('unsupported_language');
    const options = {npServiceName:serviceFor(game.platform), headerOverrides:{'Accept-Language':language}};
    const r = await this.#pages('getTitleTrophies', [game.setId,'all'], 'trophies', options);
    const groups = await this.#call('getTitleTrophyGroups',game.setId,options);
    if (!Array.isArray(groups.trophyGroups) || groups.trophySetVersion !== r.version) invalid();
    const catalog = r.items.map(t => {
      if (!Number.isInteger(t.trophyId) || typeof t.trophyName !== 'string' || typeof t.trophyGroupId !== 'string') invalid();
      return {id:String(t.trophyId), groupId:t.trophyGroupId, name:t.trophyName, description:t.trophyDetail ?? null, iconUrl:t.trophyIconUrl ?? null, grade:t.trophyType, hidden:t.trophyHidden === true};
    });
    return {...game, version:r.version, catalog, groups:groups.trophyGroups, pages:r.pages, requestedLanguage:language, observedAt:new Date(this.#clock()).toISOString()};
  }
  async getAccountTrophies(game) {
    const r = await this.#pages('getUserTrophiesEarnedForTitle',['me',game.setId,'all'],'trophies',{npServiceName:serviceFor(game.platform)});
    const observedAt = new Date(this.#clock()).toISOString();
    return {setId:game.setId, version:r.version, accountKey:this.accountKey, observedAt, pages:r.pages, trophies:r.items.map(t => {
      if (!Number.isInteger(t.trophyId) || typeof t.earned !== 'boolean') invalid();
      const earnedAt = t.earned && t.earnedDateTime ? t.earnedDateTime : null;
      if (earnedAt && !Number.isFinite(Date.parse(earnedAt))) invalid();
      return {id:String(t.trophyId), earned:t.earned, earnedAt, observedAt, provider:'psn', progress:t.trophyProgress ?? null, progressTarget:t.trophyProgressTargetValue ?? null};
    })};
  }
  async sync(game) {
    try {
      const set = await this.getTrophySet(game), account = await this.getAccountTrophies(game);
      if (set.version !== account.version || set.catalog.length !== account.trophies.length || account.trophies.some(t => !set.catalog.some(c => c.id === t.id))) invalid();
      this.status = {...this.status,state:'ready',error:null,lastSuccessAt:account.observedAt,nextAllowedAt:this.#clock()+this.snapshotCooldownMs};
      return {schemaVersion:1, dataKind:'live_psn', set, account, sync:this.getSyncStatus()};
    } catch(e) { this.status.state='degraded'; this.status.error=e.code ?? 'upstream_or_schema_error'; throw e; }
  }
  getSyncStatus() { return structuredClone(this.status); }
  continueAfterTitleFailure(){if(['privacy_or_access_denied','endpoint_or_title_missing','schema_changed','upstream_or_schema_error'].includes(this.status.error))this.status.nextAllowedAt=0;}
}
