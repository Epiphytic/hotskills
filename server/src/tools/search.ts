import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { getAuditData, type SkillAuditData } from '../audit.js';
import { cacheAgeSeconds, cachePath, cacheRead, cacheWrite } from '../cache.js';
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
 * `auto` becomes `cli` when `npx` is on PATH, else `api`.
 */
export function resolveFindStrategy(
  configured: FindStrategy,
  env: NodeJS.ProcessEnv = process.env
): 'cli' | 'api' {
  if (configured === 'cli') return 'cli';
  if (configured === 'api') return 'api';
  return detectCliAvailable(env) ? 'cli' : 'api';
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

async function decorateWithAudit(seeds: SeedEntry[]): Promise<SearchResultEntry[]> {
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
    out.push({ ...r, audit, gate_status: 'unknown' });
  }
  return out;
}

// ─── Search engine ───

export interface SearchOptions {
  configDir?: string;
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
  const apiClient = opts.apiClient ?? searchSkillsAPI;
  const cliRunner = opts.cliRunner ?? searchViaCli;
  const decorate = opts.auditDecorator ?? decorateWithAudit;

  const key = buildCacheKey(query, findStrategy, opts.sources);
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
    raw = await apiClient(query);
  } else {
    raw = await cliRunner(query);
  }

  const seeds: SeedEntry[] = raw.map((r) => {
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

  const decorated = await decorate(seeds);
  const filtered = opts.sources
    ? decorated.filter((r) => opts.sources!.some((s) => r.source === s))
    : decorated;
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
