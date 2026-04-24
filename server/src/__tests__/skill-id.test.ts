import { test } from 'node:test';
import assert from 'node:assert';
import { SkillIdError, formatSkillId, parseSkillId } from '../skill-id.js';

test('parseSkillId — happy path for skills.sh', () => {
  const got = parseSkillId('skills.sh:vercel-labs/agent-skills:react-best-practices');
  assert.deepStrictEqual(got, {
    source: 'skills.sh',
    owner: 'vercel-labs',
    repo: 'agent-skills',
    slug: 'react-best-practices',
  });
});

test('parseSkillId — happy path for github', () => {
  const got = parseSkillId('github:anthropics/example:my-skill');
  assert.strictEqual(got.source, 'github');
  assert.strictEqual(got.owner, 'anthropics');
  assert.strictEqual(got.repo, 'example');
  assert.strictEqual(got.slug, 'my-skill');
});

test('parseSkillId — happy path for git', () => {
  const got = parseSkillId('git:my-org/my-repo:cool.skill_name');
  assert.strictEqual(got.source, 'git');
  assert.strictEqual(got.slug, 'cool.skill_name');
});

test('parseSkillId — rejects missing source', () => {
  assert.throws(() => parseSkillId('vercel-labs/agent-skills:react-best-practices'), SkillIdError);
});

test('parseSkillId — rejects unknown source', () => {
  assert.throws(
    () => parseSkillId('npm:vercel-labs/agent-skills:react-best-practices'),
    /unknown source/
  );
});

test('parseSkillId — rejects missing slug', () => {
  assert.throws(
    () => parseSkillId('skills.sh:vercel-labs/agent-skills'),
    /missing ':' between repo and slug/
  );
});

test('parseSkillId — rejects empty slug', () => {
  assert.throws(() => parseSkillId('skills.sh:vercel-labs/agent-skills:'), /empty slug/);
});

test('parseSkillId — rejects empty owner', () => {
  assert.throws(() => parseSkillId('skills.sh:/agent-skills:slug'), /empty owner/);
});

test('parseSkillId — rejects empty repo', () => {
  assert.throws(() => parseSkillId('skills.sh:owner/:slug'), /empty repo/);
});

test('parseSkillId — rejects extra colons after slug', () => {
  assert.throws(
    () => parseSkillId('skills.sh:owner/repo:slug:extra'),
    /extra ':' after slug/
  );
});

test('parseSkillId — rejects shell metacharacters in segments', () => {
  assert.throws(() => parseSkillId('skills.sh:owner;rm/repo:slug'), /unsafe character in owner/);
  assert.throws(() => parseSkillId('skills.sh:owner/re$po:slug'), /unsafe character in repo/);
  assert.throws(() => parseSkillId('skills.sh:owner/repo:sl|ug'), /unsafe character in slug/);
});

test('parseSkillId — rejects path traversal in segments', () => {
  // '..' alone is allowed by SAFE_NAME (has no slash), but a slug with '/'
  // is rejected explicitly.
  assert.throws(() => parseSkillId('skills.sh:owner/repo:foo/bar'), /'\/' is not allowed in slug/);
});

test('parseSkillId — rejects whitespace', () => {
  assert.throws(() => parseSkillId(' skills.sh:o/r:s'), /whitespace/);
  assert.throws(() => parseSkillId('skills.sh:o/r:s '), /whitespace/);
});

test('parseSkillId — rejects empty input', () => {
  assert.throws(() => parseSkillId(''), /empty/);
});

test('parseSkillId — rejects non-string input', () => {
  assert.throws(() => parseSkillId(null as unknown as string), SkillIdError);
  assert.throws(() => parseSkillId(undefined as unknown as string), SkillIdError);
  assert.throws(() => parseSkillId(42 as unknown as string), SkillIdError);
});

test('parseSkillId — accepts dots, underscores, dashes in segments', () => {
  const got = parseSkillId('github:my.org/my_repo-2:skill.name_v1');
  assert.strictEqual(got.owner, 'my.org');
  assert.strictEqual(got.repo, 'my_repo-2');
  assert.strictEqual(got.slug, 'skill.name_v1');
});

test('formatSkillId — round-trips parsed IDs', () => {
  const id = 'skills.sh:vercel-labs/agent-skills:react-best-practices';
  assert.strictEqual(formatSkillId(parseSkillId(id)), id);
});

test('SkillIdError — carries raw input and reason for diagnostics', () => {
  try {
    parseSkillId('bad input');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof SkillIdError);
    assert.strictEqual(err.raw, 'bad input');
    assert.ok(err.reason.length > 0);
    assert.ok(err.message.includes('bad input'));
  }
});
