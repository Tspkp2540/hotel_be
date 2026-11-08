// Only assertion failures are evidence that a semantic mutation was detected.
export function classifyMutation(report, exitCode) {
  const invalid = { status:'invalid', passed:0, failed:[], skipped:0 };
  if (!Array.isArray(report?.testResults) || !report.testResults.length || !report.testResults.every(suite=>Array.isArray(suite.assertionResults))) return invalid;
  const assertions=report.testResults.flatMap(suite=>suite.assertionResults);
  const failed=assertions.filter(test=>test.status==='failed');
  const details={passed:assertions.filter(test=>test.status==='passed').length,failed:failed.map(test=>test.fullName),skipped:assertions.filter(test=>test.status==='pending'||test.status==='skipped'||test.status==='todo').length};
  if (failed.some(test=>(test.failureMessages??[]).some(message=>/Test timed out in|Hook timed out in/.test(message)))) return {status:'timeout',...details};
  if (report.numRuntimeErrorTestSuites>0 || report.testResults.some(suite=>suite.status==='failed'&&!suite.assertionResults.length) || details.skipped || !assertions.length) return {status:'invalid',...details};
  if (exitCode===0 && !failed.length && report.success) return {status:'survived',...details};
  if (exitCode===1 && failed.length) return {status:'killed',...details};
  return {status:'invalid',...details};
}
