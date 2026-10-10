/** Internal container binding is separate from permission to publish host ports.
 * The deployment runner must independently validate host port bindings. */
export function assertListenPolicy(config,env=process.env){
  const host=config.bindHost??'127.0.0.1';
  if(['127.0.0.1','::1'].includes(host))return;
  if(config.publicationApproved===true)return;
  if(host==='0.0.0.0'&&config.privateNetworkApproved===true&&env.PLATINUM_PRIVATE_CONTAINER==='1')return;
  throw new Error('publication_not_authorized');
}
