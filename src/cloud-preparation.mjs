// Read-only cross-file checks, never an authorization to deploy or migrate.
export function checkCloudPreparation(config, realm) {
  const errors = [], pending = [];
  const check = (ok, code) => { if (!ok) errors.push(code); };
  const oauth = config.oauth ?? {};
  const android = realm.clients?.find(c => c.clientId === config.mobileClientId);
  check(realm.realm === 'companion' && realm.enabled === true, 'realm_mismatch');
  check(realm.registrationAllowed === false && realm.bruteForceProtected === true, 'realm_access_policy');
  check(realm.revokeRefreshToken === true && realm.refreshTokenMaxReuse === 0, 'refresh_rotation_required');
  check(realm.accessTokenLifespan > 0 && realm.accessTokenLifespan <= 300, 'access_lifetime');
  check(android?.publicClient === true && android.standardFlowEnabled === true && android.directAccessGrantsEnabled === false && android.implicitFlowEnabled === false && android.serviceAccountsEnabled === false, 'native_client_flow');
  check(android?.attributes?.['pkce.code.challenge.method'] === 'S256', 'pkce_required');
  check(android?.redirectUris?.length === 1 && android.redirectUris[0] === 'app.platinumcompanion.android:/oauthredirect', 'exact_android_redirect');
  check(android?.fullScopeAllowed === false, 'unbounded_client_scope');
  const scopes = android?.defaultClientScopes ?? [];
  check(['platinum:read', 'platinum:sync'].every(s => scopes.includes(s) && realm.clientScopes?.some(c => c.name === s)), 'api_scopes_missing');
  check(android?.optionalClientScopes?.includes('offline_access'), 'android_offline_scope_missing');
  check(android?.protocolMappers?.some(m => m.protocolMapper === 'oidc-audience-mapper' && m.config?.['included.custom.audience'] === oauth.audience && m.config?.['access.token.claim'] === 'true'), 'audience_mapper_mismatch');
  check(android?.protocolMappers?.some(m => m.protocolMapper === 'oidc-sub-mapper' && m.config?.['access.token.claim'] === 'true'), 'subject_mapper_missing');
  check(oauth.requireSessionId === true && oauth.allowedClientIds?.includes(config.mobileClientId), 'session_or_client_validation');
  check(oauth.maxTokenLifetimeSeconds >= realm.accessTokenLifespan && oauth.maxTokenLifetimeSeconds <= 900, 'token_lifetime_policy');
  try {
    const issuer = new URL(oauth.issuer), resource = new URL(oauth.resource), jwks = new URL(oauth.jwksUri);
    check([issuer, resource, jwks].every(u => u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash), 'https_endpoints_required');
    check(issuer.pathname === '/realms/companion' && jwks.href === issuer.href + '/protocol/openid-connect/certs', 'issuer_jwks_mismatch');
    check(resource.pathname === '/mcp' && resource.hostname !== issuer.hostname && config.allowedHosts?.includes(resource.hostname), 'resource_host_mismatch');
    if ([issuer, resource].some(u => u.hostname.endsWith('.invalid') || u.hostname.endsWith('.test'))) pending.push('production_dns_names_not_selected');
  } catch { errors.push('invalid_endpoint'); }
  if (!oauth.ownerSubject || /REQUIRED|synthetic/.test(oauth.ownerSubject)) pending.push('real_owner_subject_missing');
  if (config.selectedSets?.length !== 5 || config.selectedSets.some(g => g.platform !== 'PS5' || !/^NPWR\d{5,8}_\d{2}$/.test(g.setId))) pending.push('five_confirmed_bindings_required');
  check(config.credentialInstallApproved === false && config.scheduledSyncEnabled === false, 'sony_disabled_until_separate_approval');
  // These require external evidence; this static command deliberately cannot pass them.
  pending.push('independent_ssh_host_verification', 'dns_control_and_change_approval', 'public_api_identity_approval', 'public_tls_chain', 'real_owner_mfa_and_offline_access_role', 'production_backup_restore', 'samsung_oauth_callback');
  return {checkedAt: new Date().toISOString(), preparation: errors.length ? 'FAIL' : 'PASS', production: 'NOT_VERIFIED', errors, pending, performedNetworkRequests: false};
}
