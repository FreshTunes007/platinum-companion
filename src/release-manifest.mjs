import {createHash, createPublicKey, verify} from 'node:crypto';
export const packageName='app.platinumcompanion.android';
export function validateRelease(p) {
  if(p.schemaVersion!==1 || !/^[a-z0-9-]+$/.test(p.appId) || !/^[a-z][a-z0-9_.]+$/.test(p.packageName) || !['stable','beta'].includes(p.releaseChannel)) throw Error('release_identity');
  for(const f of ['versionCode','releaseSequence','minimumAndroidVersion','apkSize']) if(!Number.isSafeInteger(p[f])||p[f]<=0) throw Error('release_number');
  if(!/^\d+\.\d+\.\d+$/.test(p.versionName)|| !/^[a-f0-9]{64}$/.test(p.sha256)||!/^[a-f0-9]{64}$/.test(p.signingCertificateSha256)) throw Error('release_digest_version');
  const url=new URL(p.apkUrl);
  if(url.origin!=='https://freshoryx.com'||url.username||url.password||url.search||url.hash||!url.pathname.startsWith(`/downloads/${p.appId}/`)||!url.pathname.endsWith('.apk')) throw Error('release_url');
  if(typeof p.mandatoryUpdate!=='boolean'||!Array.isArray(p.changelog)||p.changelog.length>20||p.changelog.some(s=>typeof s!=='string'||s.length>500)) throw Error('release_content');
  for(const f of ['releaseDate','expiresAt']) if(!Number.isFinite(Date.parse(p[f]))) throw Error('release_date');
  return p;
}
export function verifyRelease(envelope, publicDer, {now=Date.now(), highestSequence=0}={}) {
  if(envelope.schemaVersion!==1||envelope.keyId!=='freshoryx-rsa-2026'||envelope.algorithm!=='RS256') throw Error('signature_envelope');
  const bytes=Buffer.from(envelope.payload,'base64');
  if(bytes.length>32768 || !verify('RSA-SHA256',bytes,createPublicKey({key:Buffer.from(publicDer,'base64'),format:'der',type:'spki'}),Buffer.from(envelope.signature,'base64'))) throw Error('signature_invalid');
  const p=validateRelease(JSON.parse(bytes));
  if(Date.parse(p.expiresAt)<now||p.releaseSequence<highestSequence) throw Error('release_expired_or_replayed');
  return p;
}
export function assertArtifact(p, bytes) {
  if(bytes.length!==p.apkSize||createHash('sha256').update(bytes).digest('hex')!==p.sha256) throw Error('artifact_mismatch');
}
