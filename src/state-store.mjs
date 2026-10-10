import {readFile,writeFile,rename,open,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {assertRealState} from './roadmap.mjs';
export class StateStore {
  constructor(path){this.path=path instanceof URL?fileURLToPath(path):path;}
  async read(){return JSON.parse(await readFile(this.path,'utf8'));}
  async writeInitial(state){assertRealState(state);await writeFile(this.path,JSON.stringify(state,null,2),{flag:'wx'});}
  async update(expectedRevision,change){
    const lockPath=`${this.path}.lock`,temp=`${this.path}.${randomUUID()}.tmp`;
    const lock=await open(lockPath,'wx');
    try {
      const state=await this.read();
      if(state.player.stateRevision!==expectedRevision) throw new Error('state_revision_conflict');
      const next=change(structuredClone(state));
      next.player.stateRevision=expectedRevision+1;
      assertRealState(next);
      await writeFile(temp,JSON.stringify(next,null,2));await rename(temp,this.path);
      return next;
    } finally {
      await lock.close();await unlink(lockPath);
      await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});
    }
  }
}
