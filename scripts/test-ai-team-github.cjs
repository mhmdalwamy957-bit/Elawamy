'use strict';

const assert = require('node:assert/strict');

(async () => {
  process.env.GITHUB_TOKEN = 'unit-test-token';
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  process.env.GITHUB_BASE_BRANCH = 'ai-team-bootstrap-20261125';

  const {
    getElaWamyGitHubConnectionStatus,
    getElaWamyGitHubRepositorySnapshot,
    createElaWamyGitHubDraftPullRequest
  } = await import('../server/ai-team-github.js');

  const source = 'const flag = false;\nexport { flag };\n';
  const blob = Buffer.from(source, 'utf8').toString('base64');
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const method = options.method || 'GET';
    calls.push({ path, method });
    let payload;
    if (path === '/repos/owner/repo' && method === 'GET') {
      payload = { full_name: 'owner/repo', private: true, visibility: 'private' };
    } else if (path === '/repos/owner/repo/git/ref/heads/ai-team-bootstrap-20261125' && method === 'GET') {
      payload = { object: { sha: 'base-sha', url: 'https://api.github.test/ref' } };
    } else if (path === '/repos/owner/repo/git/commits/base-sha' && method === 'GET') {
      payload = { tree: { sha: 'tree-sha' } };
    } else if (path === '/repos/owner/repo/git/trees/tree-sha' && method === 'GET') {
      payload = { truncated: false, tree: [
        { path: 'public/js/example.js', type: 'blob', sha: 'blob-sha', size: Buffer.byteLength(source) },
        { path: 'firebase-config.generated.json', type: 'blob', sha: 'config-sha', size: 469 },
        { path: 'firestore.rules', type: 'blob', sha: 'rules-sha', size: 300 }
      ] };
    } else if (path === '/repos/owner/repo/git/blobs/blob-sha' && method === 'GET') {
      payload = { encoding: 'base64', content: blob };
    } else if (path === '/repos/owner/repo/git/blobs/rules-sha' && method === 'GET') {
      payload = { encoding: 'base64', content: Buffer.from("rules_version = '2';").toString('base64') };
    } else if (path === '/repos/owner/repo/git/refs' && method === 'POST') {
      payload = { ref: 'refs/heads/ai-team/task-test' };
    } else if (path === '/repos/owner/repo/contents/public/js/example.js' && method === 'PUT') {
      const updated = Buffer.from(JSON.parse(options.body).content, 'base64').toString('utf8');
      assert.match(updated, /const flag = true;/);
      payload = { commit: { sha: 'new-commit-sha' } };
    } else if (path === '/repos/owner/repo/pulls' && method === 'POST') {
      const body = JSON.parse(options.body);
      assert.equal(body.base, 'ai-team-bootstrap-20261125');
      assert.equal(body.draft, true);
      assert.match(body.body, /لم تُشغّل الاختبارات/);
      payload = { number: 7, html_url: 'https://github.com/owner/repo/pull/7', draft: true };
    } else {
      throw new Error(`Unexpected mocked GitHub request: ${method} ${path}`);
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const status = await getElaWamyGitHubConnectionStatus();
  assert.equal(status.connected, true);
  assert.equal(status.totalFiles, 3);
  assert.equal(status.textFiles, 2);
  assert.equal(status.baseBranch, 'ai-team-bootstrap-20261125');

  const snapshot = await getElaWamyGitHubRepositorySnapshot({ task: 'change flag', includeContents: true });
  assert.equal(snapshot.reviewedFiles, 2);
  assert.ok(snapshot.contextText.includes('public/js/example.js'));
  assert.ok(!snapshot.contextText.includes('firebase-config.generated.json'));

  const pr = await createElaWamyGitHubDraftPullRequest({
    taskId: 'test-task-id',
    task: 'change flag',
    report: 'Approved test change',
    generateText: async () => JSON.stringify({
      summary: 'Enable the flag',
      test_plan: ['node --check public/js/example.js'],
      changes: [{
        path: 'public/js/example.js',
        summary: 'Turn flag on',
        replace: [{ old: 'const flag = false;', new: 'const flag = true;' }]
      }]
    })
  });
  assert.equal(pr.pullRequestNumber, 7);
  assert.equal(pr.pullRequestDraft, true);
  assert.equal(pr.baseBranch, 'ai-team-bootstrap-20261125');
  assert.equal(pr.testsStatus, 'not_run');
  assert.ok(calls.some(call => call.path.endsWith('/pulls') && call.method === 'POST'));

  const beforeUnsafeRefs = calls.filter(call => call.path.endsWith('/git/refs') && call.method === 'POST').length;
  const beforeUnsafePulls = calls.filter(call => call.path.endsWith('/pulls') && call.method === 'POST').length;
  await assert.rejects(() => createElaWamyGitHubDraftPullRequest({
    taskId: 'unsafe-task-id',
    task: 'change security rules',
    report: 'Approved test change',
    generateText: async () => JSON.stringify({
      summary: 'Change Firestore rules',
      test_plan: [],
      changes: [{ path: 'firestore.rules', summary: 'Unsafe change', replace: [{ old: "rules_version = '2';", new: "rules_version = '3';" }] }]
    })
  }), /blocked or duplicate file path/);
  assert.equal(calls.filter(call => call.path.endsWith('/git/refs') && call.method === 'POST').length, beforeUnsafeRefs, 'unsafe changes must not create a branch');
  assert.equal(calls.filter(call => call.path.endsWith('/pulls') && call.method === 'POST').length, beforeUnsafePulls, 'unsafe changes must not create a pull request');

  const refsBeforeWorkflow = calls.filter(call => call.path.endsWith('/git/refs') && call.method === 'POST').length;
  const pullsBeforeWorkflow = calls.filter(call => call.path.endsWith('/pulls') && call.method === 'POST').length;
  await assert.rejects(() => createElaWamyGitHubDraftPullRequest({
    taskId: 'workflow-task-id',
    task: 'add an automatic deployment workflow',
    report: 'Approved test change',
    generateText: async () => JSON.stringify({
      summary: 'Add workflow',
      test_plan: [],
      changes: [{ path: '.github/workflows/deploy.yml', summary: 'Workflow', create: 'name: deploy\n' }]
    })
  }), /blocked or duplicate file path/);
  assert.equal(calls.filter(call => call.path.endsWith('/git/refs') && call.method === 'POST').length, refsBeforeWorkflow, 'AI must never create or change GitHub Actions workflows');
  assert.equal(calls.filter(call => call.path.endsWith('/pulls') && call.method === 'POST').length, pullsBeforeWorkflow, 'blocked workflows must not create a pull request');

  console.log('AI team GitHub checks passed: repository indexing, secret-config exclusion, protected security/workflow paths, exact text replacement, isolated branch, and draft PR only.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
