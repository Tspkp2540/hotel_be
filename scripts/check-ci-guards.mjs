import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));const results=[];
for(const target of ['backend']){
  const project=root;const folder=join(project,'.ci-work',randomUUID());
  await mkdir(folder,{recursive:true});
  try{
    const browser=target==='browser';const file=join(folder,browser?'focused.spec.ts':'focused.test.ts');
    await writeFile(file,browser?"import { test } from '@playwright/test'; test.only('focused sentinel',()=>{});":"import { test,expect } from 'vitest'; test.only('focused sentinel',()=>expect(true).toBe(true));");
    const config=join(folder,browser?'playwright.config.ts':'vitest.config.ts');
    await writeFile(config,browser?`import base from '../../playwright.config.ts'; export default {...base,testDir:${JSON.stringify(folder)},reporter:'list'};`:`import base from '../../vitest.config.ts'; export default {...base,test:{...base.test,include:[${JSON.stringify(file.replaceAll('\\','/'))}]}};`);
    const cli=join(project,browser?'node_modules/@playwright/test/cli.js':'node_modules/vitest/vitest.mjs');
    const args=browser?[cli,'test','--config',config]:[cli,'run','--config',config];
    const result=spawnSync(process.execPath,args,{cwd:project,env:{...process.env,CI:'true'},encoding:'utf8',timeout:60000});const output=result.stdout+result.stderr;
    if(result.error||result.status!==1||!/Unexpected \.only|\.only.*not allowed|forbidOnly/i.test(output))throw new Error(`${target} focused-test guard failed: ${output}`);
    results.push({target,passed:true,rejectedFocusedTests:true,exitCode:result.status});console.log(`PASS ${target}: focused tests rejected in CI`);
  }finally{
    if(!folder.startsWith(join(project,'.ci-work')+sep)||relative(project,folder).startsWith('..'))throw new Error('Unsafe guard fixture cleanup');
    await rm(folder,{recursive:true,force:true});
  }
}
await mkdir(join(root,'ci-report'),{recursive:true});await writeFile(join(root,'ci-report/guards.json'),JSON.stringify({generatedAt:new Date().toISOString(),results},null,2)+'\n');
