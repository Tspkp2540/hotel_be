import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMutation } from './mutation-results.mjs';
const report=(assertions,extra={})=>({success:assertions.every(test=>test.status==='passed'),testResults:[{status:assertions.every(test=>test.status==='passed')?'passed':'failed',assertionResults:assertions}],...extra});
const pass={status:'passed',fullName:'business boundary'};
const fail={status:'failed',fullName:'business boundary',failureMessages:['expected allowed stay, got rejection']};
const cases=[
 ['passing mutant survives',report([pass]),0,'survived'],
 ['assertion failure kills mutant',report([fail]),1,'killed'],
 ['compile/import error is invalid',report([],{success:false}),1,'invalid'],
 ['mixed assertion and compile failures are invalid',{success:false,testResults:[{status:'failed',assertionResults:[fail]},{status:'failed',assertionResults:[]}]},1,'invalid'],
 ['test timeout is not a kill',report([{...fail,failureMessages:['Test timed out in 5000ms']}]),1,'timeout'],
 ['hook timeout is not a kill',report([{...fail,failureMessages:['Hook timed out in 10000ms']}]),1,'timeout'],
 ['skipped tests cannot pass the gate',report([{status:'pending',fullName:'skipped'}]),0,'invalid'],
 ['missing report is invalid',null,1,'invalid'],
 ['inconsistent exit code is invalid',report([fail]),0,'invalid'],
 ['runtime failure without assertion is invalid',report([pass],{success:false,numRuntimeErrorTestSuites:1}),1,'invalid'],
];
for(const [name,input,code,status] of cases)test(name,()=>assert.equal(classifyMutation(input,code).status,status));
