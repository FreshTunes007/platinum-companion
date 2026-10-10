import { createHash } from 'node:crypto';

export function observation(fields) {
  if (typeof fields.accountId !== 'string' || typeof fields.setId !== 'string' || typeof fields.trophyId !== 'string') throw new Error('invalid_internal_identity');
  if (![true, false, null].includes(fields.earned)) throw new Error('invalid_earned_state');
  if (!Number.isFinite(Date.parse(fields.observedAt))) throw new Error('invalid_observed_at');
  if (fields.earnedAt !== null && (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(fields.earnedAt) || !Number.isFinite(Date.parse(fields.earnedAt)))) throw new Error('earned_at_requires_timezone');
  const id = createHash('sha256').update(JSON.stringify([
    fields.accountId, fields.setId, fields.trophyId, fields.earned, fields.earnedAt,
    fields.earnedAtDisplay, fields.observedAt, fields.source.kind,
    fields.source.externalReference, fields.progress, fields.progressTarget
  ])).digest('hex');
  const {id:ignoredId,...payload}=fields;
  return {id, ...structuredClone(payload)};
}

export function mergeObservations(existing, incoming) {
  const ids = new Map(existing.map(o => [o.id, o]));
  for (const o of incoming) {
    const old = ids.get(o.id);
    if (old && JSON.stringify(old) !== JSON.stringify(o)) throw new Error('observation_identity_collision');
    ids.set(o.id, structuredClone(o));
  }
  return [...ids.values()];
}

export function resolveAccountTrophy(observations, accountId, setId, trophyId) {
  const relevant = observations.filter(o => o.accountId === accountId && o.setId === setId && o.trophyId === trophyId);
  const positives = relevant.filter(o => o.earned === true), negatives = relevant.filter(o => o.earned === false);
  return {accountId, setId, trophyId, earned:positives.length ? true : negatives.length ? false : null,
    // Earlier not-earned -> later earned is the normal unlock lifecycle.
    // A not-earned observation at/after positive evidence needs reconciliation.
    conflict:positives.some(p=>negatives.some(n=>Date.parse(n.observedAt)>=Date.parse(p.observedAt))),observationIds:relevant.map(o=>o.id)};
}
