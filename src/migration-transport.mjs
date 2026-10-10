// Constructs a secret-free transport. Calling it never reads a vault or connects.
export function migrationTransport(config) {
  const acceptedTofu = config.hostTrust === 'TRUST_ON_FIRST_USE' && config.tofuRiskAccepted === true;
  if (config.transferApproved !== true || !(config.hostIdentityVerified === true || acceptedTofu))
    throw new Error('migration_approval_and_verified_host_required');
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]{0,252}$/.test(config.sshDestination ?? ''))
    throw new Error('invalid_ssh_destination');
  const layouts = {
    'freshoryx-maintenance': 'sudo -n docker compose -p platinum-production --env-file /var/lib/platinum-companion/compose.env -f /opt/platinum-companion/releases/0.5b-candidate/deploy/compose.production.yaml -f /opt/platinum-companion/releases/0.5b-candidate/deploy/compose.freshoryx.yaml run --rm --no-deps -T --entrypoint node companion /app/scripts/install-cloud-refresh.mjs',
    native: 'node /app/scripts/install-cloud-refresh.mjs',
    compose: 'docker compose --env-file /etc/platinum-companion/compose.env --project-directory /opt/platinum-companion -f /opt/platinum-companion/deploy/compose.yaml --profile approved-cloud exec -T companion node /app/scripts/install-cloud-refresh.mjs',
    'compose-production': 'sudo -n docker compose -p platinum-companion --env-file /etc/platinum-companion/compose.env -f /opt/platinum-companion/current/deploy/compose.production.yaml exec -T companion node /app/scripts/install-cloud-refresh.mjs',
    'freshoryx-production': 'sudo -n docker compose -p platinum-production --env-file /var/lib/platinum-companion/compose.env -f /opt/platinum-companion/releases/0.5b-candidate/deploy/compose.production.yaml -f /opt/platinum-companion/releases/0.5b-candidate/deploy/compose.freshoryx.yaml exec -T companion node /app/scripts/install-cloud-refresh.mjs',
  };
  const command = layouts[config.remoteLayout ?? 'native'];
  if (!command) throw new Error('invalid_remote_layout');
  // Never enroll or replace a host key automatically, including accepted TOFU.
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no'];
  if (config.sshConfigPath !== undefined) {
    if (typeof config.sshConfigPath !== 'string' || !/^(?:[A-Za-z]:[\\/]|\/)/.test(config.sshConfigPath) || /[\r\n\0]/.test(config.sshConfigPath))
      throw new Error('absolute_ssh_config_required');
    args.push('-F', config.sshConfigPath);
  }
  args.push(config.sshDestination, command);
  return args;
}
