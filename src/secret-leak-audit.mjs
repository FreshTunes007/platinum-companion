import {readdir,readFile,access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
export async function scanSecretLeaks(secrets,publicOutputs=[],{protectedPath=null}={}){
  const needles=secrets.filter(s=>typeof s==='string'&&s.length>0).map(s=>Buffer.from(s));
  let filesChecked=0;const matches=[];
  async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){if(['node_modules','.npm-cache','.git'].includes(e.name))continue;const path=new URL(e.name+(e.isDirectory()?'/':''),dir);if(e.isDirectory())await walk(path);else if(e.isFile()){filesChecked++;const bytes=await readFile(path);if(needles.some(n=>bytes.includes(n)))matches.push(fileURLToPath(path));}}}
  await walk(root);
  let gitDiff={available:false,reason:'not_a_git_repository'};
  try{const {stdout}=await promisify(execFile)('git',['diff','--no-ext-diff'],{cwd:fileURLToPath(root),maxBuffer:4000000});gitDiff={available:true,clean:!needles.some(n=>Buffer.from(stdout).includes(n))};}catch{}
  const stdoutClean=publicOutputs.every(o=>!needles.some(n=>Buffer.from(o).includes(n)));
  let protectedStorage=null;
  if(protectedPath){
    const bytes=await readFile(protectedPath);
    protectedStorage={plaintextSecretAbsent:!needles.some(n=>bytes.includes(n)),dpapiHeader:bytes.length>20&&bytes.readUInt32LE(0)===1};
  }
  let legacyCredentialPresent=false;try{await access(new URL('private/psn-auth.dpapi',root));legacyCredentialPresent=true;}catch{}
  return {clean:!matches.length&&stdoutClean&&gitDiff.clean!==false&&(!protectedStorage||(protectedStorage.plaintextSecretAbsent&&protectedStorage.dpapiHeader)),publicStdoutClean:stdoutClean,projectFilesClean:!matches.length,filesChecked,matchedFileCount:matches.length,gitDiff,legacyCredentialPresent,protectedStorage};
}
