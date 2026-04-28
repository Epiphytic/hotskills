import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { getAuditData, type SkillAuditData } from '../audit.js';
import { cacheAgeSeconds, cachePath, cacheRead, cacheWrite } from '../cache.js';
import {
  mergeConfigs,
  readGlobalConfig,
  readProjectConfig,
  type HotskillsConfig,
  type SourceEntry,
} from '../config.js';
import { runGatePreview, type GateOutcome } from '../gate/index.js';
import { parseSkillId, SkillIdError } from '../skill-id.js';
import { searchSkillsAPI, type SearchSkill } from '../vendor/vercel-skills/find.js';

// ─── Types ───

export type FindStrategy = 'cli' | 'api' | 'auto';

export interface SearchResultEntry {
  /** Fully-qualified skill ID per ADR-001: <source>:<owner>/<repo>:<slug> */
  skill_id: string;
  name: string;
  installs: number;
  source: string;
  slug: string;
  /** Per-skill audit data; null when no audit data is available. */
  audit: SkillAuditData | null;
  /** Phase 4 will compute a real preview; until then this is always 'unknown'. */
  gate_status: 'allow' | 'block' | 'unknown';
}

export interface SearchToolResponse {
  results: SearchResultEntry[];
  cached: boolean;
  cache_age_seconds: number | null;
}

// ─── Strategy detection ───

let cliAvailableCache: boolean | null = null;

function detectCliAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (cliAvailableCache !== null) return cliAvailableCache;
  const path = env['PATH'] ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const dirs = path.split(sep).filter(Boolean);
  const want = process.platform === 'win32' ? ['npx.cmd', 'npx.exe', 'npx'] : ['npx'];
  const has = dirs.some((d) => want.some((w) => existsSync(`${d}/${w}`)));
  cliAvailableCache = has;
  return has;
}

export function _resetCliCache(): void {
  cliAvailableCache = null;
}

/**
 * Resolve the user-configured `find_strategy` to a concrete strategy.
 * `auto` becomes `api` whenever the API endpoint is reachable; we only
 * fall back to `cli` (`npx skills find`) if `api` is forced off, since
 * the API does fuzzy matching across name/source/slug while the CLI's
 * substring match misses high-install skills (e.g. `obra/superpowers/
 * requesting-code-review` with 60K+ installs is not surfaced by the
 * CLI for `code review`, but is the top API result).
 */
export function resolveFindStrategy(
  configured: FindStrategy,
  _env: NodeJS.ProcessEnv = process.env
): 'cli' | 'api' {
  if (configured === 'cli') return 'cli';
  return 'api';
}

/**
 * Local skills.sh API client. The vendored `searchSkillsAPI` maps
 * `skill.id` (which is `owner/repo/slug` — the full path) onto the
 * `slug` field, producing canonicalized IDs like
 * `skills.sh:obra/superpowers:obra/superpowers/requesting-code-review`.
 * The API actually exposes a separate `skillId` (just the slug) for
 * exactly this purpose; we use that. Also propagates `limit` (the
 * vendored client hardcodes 10).
 *
 * Kept alongside the vendored client rather than patched into it so
 * the upstream sync (scripts/sync-vendor.mjs) stays clean.
 */
async function searchSkillsAPILocal(
  query: string,
  limit = 25
): Promise<SearchSkill[]> {
  const base = process.env['SKILLS_API_URL'] || 'https://skills.sh';
  try {
    const url = `${base}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      skills?: Array<{
        id?: string;
        skillId?: string;
        name?: string;
        installs?: number;
        source?: string;
      }>;
    };
    if (!Array.isArray(data?.skills)) return [];
    return data.skills
      .filter((s) => typeof s.skillId === 'string' && typeof s.source === 'string')
      .map((s) => ({
        name: s.name ?? s.skillId!,
        slug: s.skillId!,
        source: s.source!,
        installs: s.installs ?? 0,
      }))
      .sort((a, b) => (b.installs || 0) - (a.installs || 0));
  } catch {
    return [];
  }
}

/**
 * Normalize a free-text query into the form the skills.sh search API
 * accepts.
 *
 * The API's fuzzy-search backend treats whitespace as an end-of-query
 * marker — `q=code review` returns a schema stub with zero skills, while
 * `q=code-review` returns 20 ranked matches across `name`, `source`, and
 * `slug`. Lowercase + collapse runs of whitespace/`_`/`,` into a single
 * `-` so user-typed phrases (`"code review"`, `"Code Review"`) all
 * converge on the working hyphenated form. Trims leading/trailing
 * separators afterwards.
 *
 * Single-word queries pass through unchanged (lowercased).
 */
export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[\s_,]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ─── CLI strategy ───

interface CliResult {
  source: string; // owner/repo
  name: string;
  slug?: string;
  installs?: number;
}

/**
 * Run `npx skills find <query>` and parse stdout. The CLI prints
 * ANSI-colored human-readable output, not JSON; we extract
 * `owner/repo@skill-name` tokens line by line.
 */
async function searchViaCli(query: string, timeoutMs = 30_000): Promise<CliResult[]> {
  return new Promise((resolveOuter) => {
    // Defense in depth: even though spawn never goes through a shell, a
    // query starting with '-' could be parsed by `skills find` as a flag.
    // Push a `--` separator so all positional args after it are treated
    // as the query string verbatim.
    const proc = spawn('npx', ['skills', 'find', '--', query], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
    }, timeoutMs);

    let stdout = '';
    proc.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    proc.once('error', () => {
      clearTimeout(timer);
      resolveOuter([]);
    });
    proc.once('exit', () => {
      clearTimeout(timer);
      const stripped = stdout.replace(/\x1b\[[0-9;]*m/g, '');
      const out: CliResult[] = [];
      for (const line of stripped.split('\n')) {
        const m = line.match(/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)/);
        if (!m) continue;
        const installsM = line.match(/(\d[\d,.]*)\s*(K?|M?)\s*installs?/);
        let installs: number | undefined;
        if (installsM) {
          const n = Number(installsM[1]!.replace(/,/g, ''));
          if (Number.isFinite(n)) {
            installs =
              installsM[2] === 'K'
                ? Math.round(n * 1_000)
                : installsM[2] === 'M'
                  ? Math.round(n * 1_000_000)
                  : n;
          }
        }
        out.push({ source: m[1]!, name: m[2]!, slug: m[2]!, installs });
      }
      resolveOuter(out);
    });
  });
}

// ─── Common ───

function canonicalSkillId(source: string, slug: string): string {
  // The skills.sh API and CLI both report `source` as `owner/repo`.
  // Hotskills' canonical form prefixes the source-type discriminator.
  return source && source.includes('/')
    ? `skills.sh:${source}:${slug}`
    : `skills.sh:unknown/unknown:${slug}`;
}

interface SeedEntry {
  skill_id: string;
  name: string;
  installs: number;
  source: string;
  slug: string;
}

async function decorateWithAudit(
  seeds: SeedEntry[],
  mergedConfig?: HotskillsConfig,
  configDir?: string
): Promise<SearchResultEntry[]> {
  const out: SearchResultEntry[] = [];
  for (const r of seeds) {
    let audit: SkillAuditData | null = null;
    const m = r.source.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
    if (m) {
      try {
        const lookup = await getAuditData({
          source: 'skills.sh',
          owner: m[1]!,
          repo: m[2]!,
          slug: r.slug,
        });
        audit = lookup.audit;
      } catch {
        // Audit lookup never blocks search; treat any failure as no-data.
        audit = null;
      }
    }

    // Compute the gate preview only when we have merged config. Without it
    // (CLI invocations without project context), keep gate_status='unknown'.
    let gateStatus: 'allow' | 'block' | 'unknown' = 'unknown';
    if (mergedConfig) {
      try {
        const parsedId = parseSkillId(r.skill_id);
        const preview = await runGatePreview(parsedId, mergedConfig, {
          ...(configDir !== undefined ? { configDir } : {}),
          installCount: r.installs,
        });
        gateStatus = previewToStatus(preview);
      } catch (err) {
        if (!(err instanceof SkillIdError)) {
          // Unexpected error in preview — leave as unknown rather than failing
          // the whole search call. The picker can re-query if needed.
        }
      }
    }
    out.push({ ...r, audit, gate_status: gateStatus });
  }
  return out;
}

function previewToStatus(preview: GateOutcome): 'allow' | 'block' | 'unknown' {
  if (preview.decision === 'allow') return 'allow';
  if (preview.decision === 'block') return 'block';
  return 'unknown';
}

// ─── github-source enumeration (carried follow-up hotskills-m8r) ───

export interface GithubSearchSeed {
  skill_id: string;
  name: string;
  installs: number;
  source: string; // owner/repo
  slug: string;
  preferred: boolean;
}

export type GithubEnumerator = (
  source: SourceEntry,
  query: string
) => Promise<GithubSearchSeed[]>;

/**
 * Default github source enumerator: GET the GitHub Trees API for the
 * source's HEAD ref, walk the tree for SKILL.md files in the four
 * scan-order subdirectories, and emit one seed per match.
 *
 * Best-effort: any network failure or non-2xx response yields []. Failures
 * never break a search call — the skills.sh path still produces results.
 */
const SCAN_PREFIXES: readonly string[] = ['', 'skills/', '.claude/skills/', '.agents/skills/'];

/**
 * Same SAFE_NAME alphabet as materialize.ts assertSafeSkillId. Config
 * schema validates `type: string` for owner/repo but doesn't constrain
 * characters; without this guard a malicious config could inject `..` or
 * URL-significant characters into the GitHub Trees API URL.
 */
const SAFE_REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SAFE_REF = /^[A-Za-z0-9._/-]+$/;

export const defaultGithubEnumerator: GithubEnumerator = async (source, query) => {
  if (!SAFE_REPO_SEGMENT.test(source.owner) || !SAFE_REPO_SEGMENT.test(source.repo)) {
    return [];
  }
  const ref = source.branch ?? 'HEAD';
  if (!SAFE_REF.test(ref)) return [];
  const url = `https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${ref}?recursive=1`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return [];
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as { tree?: unknown }).tree)
  ) {
    return [];
  }
  const tree = (body as { tree: Array<{ path: string; type: string }> }).tree;
  const out: GithubSearchSeed[] = [];
  const q = query.toLowerCase();
  for (const entry of tree) {
    if (entry.type !== 'blob') continue;
    if (!entry.path.endsWith('/SKILL.md') && entry.path !== 'SKILL.md') continue;

    // Determine slug per scan order (longest matching prefix wins).
    let slug: string | null = null;
    for (const prefix of SCAN_PREFIXES) {
      const expected = `${prefix}`;
      if (expected === '' && entry.path === 'SKILL.md') {
        slug = source.repo; // root SKILL.md uses repo name
        break;
      }
      if (expected !== '' && entry.path.startsWith(expected) && entry.path.endsWith('/SKILL.md')) {
        const inner = entry.path.slice(expected.length, -'/SKILL.md'.length);
        // Reject nested skills (only one level under prefix).
        if (inner.includes('/')) continue;
        if (inner === '') continue;
        slug = inner;
        break;
      }
    }
    if (slug === null) continue;
    if (q !== '' && !slug.toLowerCase().includes(q)) continue;

    out.push({
      skill_id: `github:${source.owner}/${source.repo}:${slug}`,
      name: slug,
      installs: 0, // github sources have no install metric
      source: `${source.owner}/${source.repo}`,
      slug,
      preferred: source.preferred === true,
    });
  }
  return out;
};

async function enumerateGithubSeeds(
  configDir: string,
  query: string,
  enumerator: GithubEnumerator,
  sourcesFilter: string[] | undefined,
  projectCwd: string | undefined
): Promise<GithubSearchSeed[]> {
  // Read merged config to pick up github sources. Skip if projectCwd
  // unknown (CLI invocations may not have one).
  let merged;
  try {
    const project = projectCwd ? await readProjectConfig(projectCwd) : { version: 1 };
    const global = await readGlobalConfig(configDir);
    merged = mergeConfigs(global, project);
  } catch {
    return [];
  }
  const sources = (merged.sources ?? []).filter((s) => s.type === 'github');
  if (sources.length === 0) return [];

  const out: GithubSearchSeed[] = [];
  for (const source of sources) {
    const ownerRepo = `${source.owner}/${source.repo}`;
    if (sourcesFilter && !sourcesFilter.includes(ownerRepo)) continue;
    // Per-source on-disk cache (1h TTL) keyed by owner/repo + query.
    const cacheKey = createHash('sha256')
      .update(`gh ${ownerRepo} ${query}`)
      .digest('hex');
    const path = cachePath(configDir, 'github-sources', cacheKey);
    let seeds = await cacheRead<GithubSearchSeed[]>(path, 3600);
    if (!seeds) {
      seeds = await enumerator(source, query);
      try {
        cacheWrite(path, seeds);
      } catch {
        // non-fatal
      }
    }
    out.push(...seeds);
  }
  return out;
}

// ─── Search engine ───

export interface SearchOptions {
  configDir?: string;
  /** Project cwd for reading per-project config (github sources). */
  projectCwd?: string;
  findStrategy?: FindStrategy;
  /** Max results to keep after merging (default 25). */
  limit?: number;
  /** owner/repo restriction (matches `source` field). */
  sources?: string[];
  /** Inject the API client (for tests). */
  apiClient?: typeof searchSkillsAPI;
  /** Inject the CLI runner (for tests). */
  cliRunner?: typeof searchViaCli;
  /** Inject audit decoration (for tests). */
  auditDecorator?: typeof decorateWithAudit;
  /** Inject github source enumerator (for tests). */
  githubEnumerator?: GithubEnumerator;
  /** Skip cache read/write entirely (for tests / `--fresh` callers). */
  skipCache?: boolean;
}

function getConfigDir(opts?: SearchOptions): string {
  const dir = opts?.configDir ?? process.env['HOTSKILLS_CONFIG_DIR'];
  if (!dir || dir.trim() === '') {
    throw new Error('HOTSKILLS_CONFIG_DIR is not set');
  }
  return dir;
}

function buildCacheKey(query: string, strategy: FindStrategy, sources: string[] | undefined): string {
  const sortedSources = sources ? [...sources].sort().join(',') : '';
  return createHash('sha256').update(`${strategy} ${query} ${sortedSources}`).digest('hex');
}

export async function runSearch(query: string, opts: SearchOptions = {}): Promise<SearchToolResponse> {
  const configDir = getConfigDir(opts);
  const findStrategy: FindStrategy = opts.findStrategy ?? 'auto';
  const limit = opts.limit ?? 25;
  const apiClient = opts.apiClient ?? ((q: string) => searchSkillsAPILocal(q, limit));
  const cliRunner = opts.cliRunner ?? searchViaCli;
  const decorate = opts.auditDecorator ?? decorateWithAudit;

  // Normalize the query before fetch + cache lookup. `code review` and
  // `Code Review` must hit the same cache slot as `code-review` since
  // the API rejects whitespace; without this they'd each cache empty
  // result sets independently.
  const effectiveQuery = normalizeQuery(query);

  const key = buildCacheKey(effectiveQuery, findStrategy, opts.sources);
  const path = cachePath(configDir, 'search', key);

  if (!opts.skipCache) {
    const cached = await cacheRead<SearchResultEntry[]>(path, 3600);
    if (cached) {
      const filtered = opts.sources
        ? cached.filter((r) => opts.sources!.some((s) => r.source === s))
        : cached;
      return {
        results: filtered.slice(0, limit),
        cached: true,
        cache_age_seconds: cacheAgeSeconds(path),
      };
    }
  }

  const concrete = resolveFindStrategy(findStrategy);
  let raw: Array<SearchSkill | CliResult>;
  if (concrete === 'api') {
    raw = await apiClient(effectiveQuery);
  } else {
    raw = await cliRunner(effectiveQuery);
  }

  // Filter out the schema-stub sentinel that the skills.sh API returns
  // for some malformed/empty queries (`{source: "owner/repo", name: "skill"}`).
  // It otherwise outranks real results in the merged response.
  const filteredRaw = raw.filter(
    (r) => !(r.source === 'owner/repo' && (r.name === 'skill' || (r as SearchSkill).slug === 'skill'))
  );

  const seeds: SeedEntry[] = filteredRaw.map((r) => {
    const slug = (r as SearchSkill).slug ?? (r as CliResult).slug ?? r.name;
    const installs = r.installs ?? 0;
    return {
      skill_id: canonicalSkillId(r.source, slug),
      name: r.name,
      installs,
      source: r.source,
      slug,
    };
  });

  // ─── Build merged config for gate preview decoration (hotskills-srt) ───
  // Best-effort: if config IO fails (missing files, perm errors), skip the
  // preview entirely — search must remain usable without per-project state.
  const projectCwd = opts.projectCwd ?? process.env['HOTSKILLS_PROJECT_CWD'];
  let mergedForPreview: HotskillsConfig | undefined;
  try {
    const project = projectCwd ? await readProjectConfig(projectCwd) : { version: 1 };
    const global = await readGlobalConfig(configDir);
    mergedForPreview = mergeConfigs(global, project);
  } catch {
    mergedForPreview = undefined;
  }

  const decorated = await decorate(seeds, mergedForPreview, configDir);

  // ─── Github source enumeration (hotskills-m8r) ───
  let githubSeeds: GithubSearchSeed[] = [];
  if (projectCwd) {
    const enumerator = opts.githubEnumerator ?? defaultGithubEnumerator;
    try {
      githubSeeds = await enumerateGithubSeeds(
        configDir,
        query,
        enumerator,
        opts.sources,
        projectCwd
      );
    } catch {
      // best-effort
    }
  }
  const githubResults: SearchResultEntry[] = [];
  for (const g of githubSeeds) {
    let gateStatus: 'allow' | 'block' | 'unknown' = 'unknown';
    if (mergedForPreview) {
      try {
        const parsedId = parseSkillId(g.skill_id);
        const preview = await runGatePreview(parsedId, mergedForPreview, {
          configDir,
          installCount: g.installs,
        });
        gateStatus = previewToStatus(preview);
      } catch {
        // leave as unknown
      }
    }
    githubResults.push({
      skill_id: g.skill_id,
      name: g.name,
      installs: g.installs,
      source: g.source,
      slug: g.slug,
      audit: null,
      gate_status: gateStatus,
    });
  }

  // Merge: skills.sh first by default, but preferred github sources (any
  // entry where the owner/repo source had preferred:true) move to the top.
  const githubPreferred = githubResults.filter((r) =>
    githubSeeds.some((s) => s.skill_id === r.skill_id && s.preferred)
  );
  const githubRest = githubResults.filter((r) => !githubPreferred.includes(r));
  const combined = [...githubPreferred, ...decorated, ...githubRest];

  // Dedupe by skill_id (skills.sh and github don't normally collide, but
  // defense in depth — first occurrence wins).
  const seen = new Set<string>();
  const deduped = combined.filter((r) => {
    if (seen.has(r.skill_id)) return false;
    seen.add(r.skill_id);
    return true;
  });

  const filtered = opts.sources
    ? deduped.filter((r) => opts.sources!.some((s) => r.source === s))
    : deduped;
  const limited = filtered.slice(0, limit);

  if (!opts.skipCache) {
    try {
      cacheWrite(path, limited);
    } catch {
      // Cache-write failures are non-fatal; downstream callers see cached:false.
    }
  }

  return { results: limited, cached: false, cache_age_seconds: null };
}

// ─── Tool registration ───

export function registerSearch(server: McpServer): void {
  server.tool(
    'hotskills.search',
    'Search for skills from skills.sh and configured sources',
    {
      query: z.string().describe('Search query'),
      limit: z.number().int().positive().optional().describe('Max results to return'),
      sources: z
        .array(z.string())
        .optional()
        .describe('Filter to specific owner/repo sources (e.g., ["vercel-labs/agent-skills"])'),
    },
    async ({ query, limit, sources }) => {
      try {
        const response = await runSearch(query, { limit, sources });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'search_failed',
                message: err instanceof Error ? err.message : String(err),
              }),
            },
          ],
        };
      }
    }
  );
}
