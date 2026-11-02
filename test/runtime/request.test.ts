import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Operation } from '../../src/map/types.ts';
import { checkUrl, isPrivateAddress, normalisePolicy, resolveRedirect, sameOrigin } from '../../src/runtime/policy.ts';
import { coerceArgs, prepareRequest } from '../../src/runtime/request.ts';
import { validateBindings } from '../../src/runtime/secrets.ts';

const operation: Operation = {
  id: 'repo.issues.list',
  resource: 'repo',
  returns: 'issue',
  title: 'List issues',
  request: {
    method: 'GET',
    path: '/repos/{owner}/{repo}/issues',
    query: { state: '{state}', per_page: '{per_page}' },
    headers: { accept: 'application/vnd.github+json' },
  },
  input: {
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' },
      per_page: { type: 'integer', default: 100, maximum: 100 },
    },
  },
};

function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  assert.ok(result.ok, JSON.stringify((result as { error: unknown }).error));
  return (result as { ok: true; value: T }).value;
}

function expectErr(result: { ok: boolean; error?: { code: string; hint?: string; message: string } }): { code: string; hint?: string; message: string } {
  assert.equal(result.ok, false);
  return (result as { ok: false; error: { code: string; hint?: string; message: string } }).error;
}

test('arguments are validated, defaulted and coerced', () => {
  const args = expectOk(coerceArgs(operation, { owner: 'microsoft', repo: 'vscode', per_page: '30' }));
  assert.equal(args['per_page'], 30, 'a numeric string becomes a number');
  assert.equal(args['state'], 'open', 'a default fills in');
});

test('a missing required argument names the shape of the call', () => {
  const error = expectErr(coerceArgs(operation, { owner: 'microsoft' }));
  assert.equal(error.code, 'missing_argument');
  assert.match(error.hint ?? '', /repo: string required/);
});

test('an unknown argument is an error with the valid list', () => {
  const error = expectErr(coerceArgs(operation, { owner: 'a', repo: 'b', page: 2 }));
  assert.equal(error.code, 'unknown_argument');
  assert.match(error.hint ?? '', /arguments: owner, repo, state, per_page/);
});

test('an enum and a maximum are enforced', () => {
  const badEnum = expectErr(coerceArgs(operation, { owner: 'a', repo: 'b', state: 'pending' }));
  assert.equal(badEnum.code, 'invalid_argument');
  assert.match(badEnum.message, /one of "open", "closed", "all"/);

  const tooBig = expectErr(coerceArgs(operation, { owner: 'a', repo: 'b', per_page: 500 }));
  assert.equal(tooBig.code, 'invalid_argument');
  assert.match(tooBig.message, /<= 100/);
});

test('path placeholders are encoded and query templates resolved', () => {
  const args = { owner: 'a b', repo: 'c/d', state: 'closed', per_page: 5 };
  const prepared = expectOk(prepareRequest('https://api.github.com', operation, args));

  assert.equal(prepared.url.pathname, '/repos/a%20b/c%2Fd/issues');
  assert.equal(prepared.url.searchParams.get('state'), 'closed');
  assert.equal(prepared.url.searchParams.get('per_page'), '5');
  assert.deepEqual(prepared.headers, { accept: 'application/vnd.github+json' });
});

test('an optional argument that was never supplied omits the query parameter', () => {
  const optional: Operation = {
    ...operation,
    input: { required: ['owner', 'repo'], properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } } },
  };

  const prepared = expectOk(prepareRequest('https://api.github.com', optional, { owner: 'a', repo: 'b' }));
  assert.equal(prepared.url.searchParams.has('state'), false);
  assert.equal(prepared.url.searchParams.has('per_page'), false);
});

test('a missing required placeholder cannot leak into the URL', () => {
  const required: Operation = {
    ...operation,
    input: { required: ['repo'], properties: { repo: { type: 'string' } } },
  };

  const error = expectErr(prepareRequest('https://api.github.com', required, { repo: 'b' }));
  assert.equal(error.code, 'missing_argument');
  assert.match(error.message, /owner/);
});

test('a body template is filled without evaluation', () => {
  const post: Operation = {
    id: 'repo.create',
    resource: 'repo',
    title: 'Create',
    mutating: true,
    request: { method: 'POST', path: '/repos/{owner}/{repo}', body: { name: '{name}', private: '{private}' } },
    input: {
      required: ['owner', 'repo', 'name'],
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        name: { type: 'string' },
        private: { type: 'boolean', default: false },
      },
    },
  };

  const prepared = expectOk(prepareRequest('https://api.github.com', post, { owner: 'a', repo: 'b', name: 'new' }));
  // A whole-field placeholder keeps the argument's type, so a JSON boolean is
  // `false` rather than the string "false".
  assert.deepEqual(JSON.parse(prepared.body ?? '{}'), { name: 'new', private: false });
});

test('a secret is attached only through a binding for the right host', () => {
  const secret = { name: 'GITHUB_TOKEN', binding: { host: 'api.github.com', header: 'authorization', format: 'Bearer {value}' }, value: 's3cret' };

  const prepared = expectOk(prepareRequest('https://api.github.com', operation, { owner: 'a', repo: 'b' }, secret));
  assert.equal(prepared.headers['authorization'], 'Bearer s3cret');
  assert.deepEqual(prepared.secret, { name: 'GITHUB_TOKEN', host: 'api.github.com', header: 'authorization' });

  const foreign = expectErr(prepareRequest('https://evil.example', operation, { owner: 'a', repo: 'b' }, secret));
  assert.equal(foreign.code, 'secret_unbound');
  assert.match(foreign.message, /bound to api\.github\.com/);
});

test('bindings are validated as names bound to exact hosts', () => {
  const good = validateBindings({ GITHUB_TOKEN: { host: 'API.GitHub.com', format: 'Bearer {value}' } });
  assert.deepEqual(good.issues, []);
  assert.equal(good.table['GITHUB_TOKEN']?.host, 'api.github.com');
  assert.equal(good.table['GITHUB_TOKEN']?.header, 'authorization');

  const bad = validateBindings({
    'bad-name': { host: 'api.github.com' },
    OK: { host: 'https://api.github.com/' },
    ALSO_OK: { host: 'api.github.com', format: 'Bearer' },
  });
  assert.ok(bad.issues.some((issue) => /bad-name/.test(issue)));
  assert.ok(bad.issues.some((issue) => /bare hostname/.test(issue)));
  assert.ok(bad.issues.some((issue) => /must contain \{value\}/.test(issue)));
});

test('the policy allows https and refuses what it should', () => {
  const policy = normalisePolicy();

  assert.ok(checkUrl('https://api.github.com/repos/a/b', policy).ok);

  const http = expectErr(checkUrl('http://api.github.com/x', policy));
  assert.equal(http.code, 'blocked_scheme');
  assert.match(http.hint ?? '', /allowPlainHttpHosts/);

  const allowed = normalisePolicy({ allowPlainHttpHosts: ['legacy.internal'] });
  assert.ok(checkUrl('http://legacy.internal/x', allowed).ok);

  const creds = expectErr(checkUrl('https://user:pass@api.github.com/x', policy));
  assert.equal(creds.code, 'url_has_credentials');

  const loopback = expectErr(checkUrl('https://127.0.0.1/x', policy));
  assert.equal(loopback.code, 'blocked_host');

  const privateNet = expectErr(checkUrl('https://192.168.1.10/x', policy));
  assert.equal(privateNet.code, 'blocked_host');

  const file = expectErr(checkUrl('file:///etc/passwd', policy));
  assert.equal(file.code, 'blocked_scheme');
});

test('private address detection covers the ranges that matter', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', 'api.github.com']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test('redirect helpers compare origins and resolve relative targets', () => {
  const a = new URL('https://api.github.com/x');
  assert.equal(sameOrigin(a, new URL('https://api.github.com/y')), true);
  assert.equal(sameOrigin(a, new URL('http://api.github.com/y')), false);
  assert.equal(sameOrigin(a, new URL('https://uploads.github.com/y')), false);

  assert.equal(expectOk(resolveRedirect(a, '/next')).href, 'https://api.github.com/next');
  assert.equal(expectOk(resolveRedirect(a, 'https://elsewhere.test/z')).href, 'https://elsewhere.test/z');
});
