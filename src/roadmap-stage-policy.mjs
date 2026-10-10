// Scheduling within the existing early-game scope; no new trophy/evidence claims.
// Future dependencies are not a promise that they can be safely postponed.
const futureAt=new Map([
  ['before_start',new Set(['w3.keira.chain','w3.keira.ally'])],
  ['before_griffin',new Set(['w3.keira.chain','w3.keira.ally'])],
  ['vizima_audience',new Set(['w3.keira.chain','w3.keira.ally'])]
]);
export function isFutureDependency(rule,player){return futureAt.get(player.facts.currentMilestone?.value)?.has(rule.ruleId)??false;}
