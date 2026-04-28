/**
 * Heuristic gate — third (opt-in) layer of the gate stack per ADR-004.
 *
 * Per ADR-004 §Gate stack step 3:
 *   Only runs when `security.heuristic.enabled: true`.
 *   Patterns scanned (each toggleable):
 *     - broad_bash_glob:   Bash(*), Bash(**), Bash without explicit allowed-list
 *     - write_outside_cwd: Write paths starting with '/', '~', or containing '..'
 *     - curl_pipe_sh:      curl ... | sh|bash|zsh
 *     - raw_network_egress: curl|wget|nc|netcat|fetch + http(s)://
 *
 *   Inputs:
 *     - SKILL.md frontmatter (`allowed-tools` field)
 *     - All files under scripts/ (recursive)
 *
 *   Mapping: 0 patterns → low, 1 → medium, 2+ → high.
 *
 *   Per-file timeout: 100ms (per pattern × file).
 *
 * Per ADR-004 §Heuristic results labeling:
 *   Findings MUST be labeled `source: "heuristic"` so the picker can
 *   distinguish them from real audit data.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { compareRisk, riskExceedsMax, type RiskCap, type RiskLevel } from './risk.js';

// ─── Types ───

export type HeuristicPattern =
  | 'broad_bash_glob'
  | 'write_outside_cwd'
  | 'curl_pipe_sh'
  | 'raw_network_egress';

export interface HeuristicFinding {
  pattern: HeuristicPattern;
  file: string;
  /** Snippet around the match, capped at 120 chars. */
  excerpt: string;
}

export type HeuristicDecisionKind = 'allow' | 'block' | 'skipped';

export interface HeuristicDecision {
  decision: HeuristicDecisionKind;
  source: 'heuristic';
  syntheticRisk: RiskLevel;
  findings: HeuristicFinding[];
  /** Block reason when decision=block: `heuristic:<pattern>:<risk>`. */
  reason?: string;
  /** Human-readable note when decision=skipped (heuristic disabled / no skill dir). */
  note?: string;
}

export interface HeuristicConfig {
  enabled?: boolean;
  patterns?: Partial<Record<HeuristicPattern, boolean>>;
}

export interface HeuristicOptions {
  /** Override per-file/per-pattern timeout (default 100ms). Tests pass small values. */
  perFileTimeoutMs?: number;
  /** Override risk_max so the heuristic gate can decide block-vs-allow. */
  riskMax?: RiskCap;
  /** Optional: pass already-loaded skill content to avoid filesystem reads (tests). */
  files?: Map<string, string>;
}

// ─── Pattern matchers ───

interface CompiledPattern {
  name: HeuristicPattern;
  scan: (text: string, deadlineMs: number) => HeuristicFinding | null;
}

/**
 * Each regex is anchored with a literal prefix to avoid catastrophic
 * backtracking. The input is also size-capped (256 KiB) and the elapsed
 * time is post-checked against deadlineMs.
 */
const RE_BROAD_BASH_GLOB = /Bash\s*\(\s*(\*\*?|\.\*)\s*\)|(?:^|\n)Bash(?!\s*\()/m;
// Match Write(...) where the path argument starts with /, ~, or contains ..
const RE_WRITE_OUTSIDE = /Write\s*\(\s*['"]?(?:[/~]|[^)'"]*\.\.)/m;
const RE_CURL_PIPE_SH = /\b(?:curl|wget)\b[^|\n]{0,200}\|\s*(?:sh|bash|zsh)\b/m;
// Match curl|wget|nc|netcat|fetch with any flags before the http(s):// URL.
const RE_RAW_NETWORK = /\b(?:curl|wget|nc|netcat|fetch)\b[^\n]{0,200}?https?:\/\/\S+/m;

const RE_FRONTMATTER_TOOLS = /^---[\r\n]+([\s\S]*?)[\r\n]+---/m;

function snippet(text: string, idx: number, len: number): string {
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + len + 30);
  return text.slice(start, end).replace(/\s+/g, ' ').slice(0, 120);
}

function timedScan(
  re: RegExp,
  text: string,
  deadlineMs: number
): { idx: number; len: number } | null {
  // Truncate input — patterns target line-level signals, so a multi-MB
  // file would only slow us down. The deadline check below catches
  // pathological backtracking; this cap is the actual safeguard.
  const limited = text.length > 256 * 1024 ? text.slice(0, 256 * 1024) : text;
  const start = Date.now();
  const m = re.exec(limited);
  if (Date.now() - start > deadlineMs) {
    // Soft breach: surface as no-match so a possibly-corrupted match
    // never produces a false-positive block.
    return null;
  }
  if (!m) return null;
  return { idx: m.index, len: m[0].length };
}

const PATTERNS: CompiledPattern[] = [
  {
    name: 'broad_bash_glob',
    scan: (text, deadline) => {
      const m = timedScan(RE_BROAD_BASH_GLOB, text, deadline);
      if (!m) return null;
      return { pattern: 'broad_bash_glob', file: '', excerpt: snippet(text, m.idx, m.len) };
    },
  },
  {
    name: 'write_outside_cwd',
    scan: (text, deadline) => {
      const m = timedScan(RE_WRITE_OUTSIDE, text, deadline);
      if (!m) return null;
      return { pattern: 'write_outside_cwd', file: '', excerpt: snippet(text, m.idx, m.len) };
    },
  },
  {
    name: 'curl_pipe_sh',
    scan: (text, deadline) => {
      const m = timedScan(RE_CURL_PIPE_SH, text, deadline);
      if (!m) return null;
      return { pattern: 'curl_pipe_sh', file: '', excerpt: snippet(text, m.idx, m.len) };
    },
  },
  {
    name: 'raw_network_egress',
    scan: (text, deadline) => {
      const m = timedScan(RE_RAW_NETWORK, text, deadline);
      if (!m) return null;
      return { pattern: 'raw_network_egress', file: '', excerpt: snippet(text, m.idx, m.len) };
    },
  },
];

// ─── File enumeration ───

function listScanFiles(skillDir: string): string[] {
  const out: string[] = [];
  const skillMd = join(skillDir, 'SKILL.md');
  try {
    if (statSync(skillMd).isFile()) out.push(skillMd);
  } catch {
    // SKILL.md missing — heuristic still runs over scripts/.
  }
  const scriptsDir = join(skillDir, 'scripts');
  let scriptStat;
  try {
    scriptStat = statSync(scriptsDir);
  } catch {
    return out;
  }
  if (!scriptStat.isDirectory()) return out;
  const stack: string[] = [scriptsDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out;
}

function readFileBounded(path: string, maxBytes: number): string | null {
  try {
    const stat = statSync(path);
    if (stat.size > maxBytes) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// ─── Risk synthesis ───

/**
 * Map distinct-pattern count to synthetic risk per ADR-004:
 *   0 patterns → low
 *   1 pattern  → medium
 *   ≥2 patterns → high
 */
export function synthesizeRisk(distinctPatternCount: number): RiskLevel {
  if (distinctPatternCount <= 0) return 'low';
  if (distinctPatternCount === 1) return 'medium';
  return 'high';
}

// ─── Public API ───

/**
 * Run the heuristic gate over a materialized skill directory.
 *
 * Returns `decision: 'skipped'` when:
 *   - heuristic.enabled is not true (per ADR-004 default OFF), OR
 *   - skillDir doesn't exist / can't be read.
 *
 * Otherwise scans SKILL.md frontmatter `allowed-tools` and all files under
 * scripts/, applying each enabled pattern with a per-file/per-pattern
 * timeout. Findings are deduplicated to distinct pattern names for the
 * synthetic risk computation, but the full findings list (including
 * duplicates across files) is returned for picker display.
 */
export function checkHeuristic(
  skillDir: string,
  heuristicCfg: HeuristicConfig | undefined,
  opts: HeuristicOptions = {}
): HeuristicDecision {
  if (!heuristicCfg?.enabled) {
    return {
      decision: 'skipped',
      source: 'heuristic',
      syntheticRisk: 'low',
      findings: [],
      note: 'heuristic.enabled=false',
    };
  }

  const enabledPatterns = new Set<HeuristicPattern>();
  const patterns = heuristicCfg.patterns ?? {};
  // Per ADR-004 schema, all patterns default to true when heuristic is enabled.
  for (const p of PATTERNS) {
    if (patterns[p.name] !== false) enabledPatterns.add(p.name);
  }

  const perFileTimeout = opts.perFileTimeoutMs ?? 100;
  const findings: HeuristicFinding[] = [];

  // ─── Source list ───
  const files: { path: string; text: string }[] = [];
  if (opts.files) {
    for (const [path, text] of opts.files) files.push({ path, text });
  } else {
    for (const path of listScanFiles(skillDir)) {
      const text = readFileBounded(path, 1024 * 1024); // 1 MiB cap per file
      if (text === null) continue;
      files.push({ path, text });
    }
  }

  // SKILL.md is split: only the YAML frontmatter is scanned for the
  // broad_bash_glob (allowed-tools) pattern — script bodies in markdown
  // wouldn't be the right surface. For non-SKILL.md files we scan the
  // full body.
  for (const f of files) {
    let scanText = f.text;
    let scanLabel = f.path;
    if (f.path.endsWith('SKILL.md')) {
      const fm = RE_FRONTMATTER_TOOLS.exec(f.text);
      if (fm && fm[1]) {
        scanText = fm[1];
        scanLabel = `${f.path}#frontmatter`;
      }
    }
    for (const p of PATTERNS) {
      if (!enabledPatterns.has(p.name)) continue;
      const finding = p.scan(scanText, perFileTimeout);
      if (finding) {
        findings.push({
          ...finding,
          file: relative(skillDir, scanLabel) || scanLabel,
        });
      }
    }
  }

  const distinct = new Set(findings.map((f) => f.pattern));
  const syntheticRisk = synthesizeRisk(distinct.size);

  const riskMax: RiskCap = opts.riskMax ?? 'medium';
  if (riskExceedsMax(syntheticRisk, riskMax)) {
    const first = findings[0];
    const reason = `heuristic:${first?.pattern ?? 'unknown'}:${syntheticRisk}`;
    return {
      decision: 'block',
      source: 'heuristic',
      syntheticRisk,
      findings,
      reason,
    };
  }

  return {
    decision: 'allow',
    source: 'heuristic',
    syntheticRisk,
    findings,
  };
}

export { compareRisk };
