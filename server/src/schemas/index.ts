import Ajv2020, { ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Per hotskills-kih (security review): Ajv must not become an algorithmic-DoS
 * surface for malicious config / state payloads. The mitigations applied:
 *   - strict mode (Ajv default for 2020) + strictTypes/strictTuples/strictRequired
 *     fail loud on schema authoring mistakes that could create
 *     ambiguous validation paths.
 *   - Pre-validation depth check rejects pathologically-nested payloads
 *     (>= MAX_PAYLOAD_DEPTH levels) before Ajv gets a chance to walk them.
 *   - Pre-validation node count check rejects payloads larger than
 *     MAX_PAYLOAD_NODES (defense against fan-out attacks where many small
 *     objects amplify Ajv's per-property overhead).
 *
 * Ajv itself does not expose a hard depth/complexity limit, so we apply
 * these guards at the JS boundary. The cost is a single recursive walk
 * over the payload BEFORE Ajv runs — O(n) where n is the node count, and
 * it short-circuits as soon as the limit is exceeded.
 */
const MAX_PAYLOAD_DEPTH = 64;
const MAX_PAYLOAD_NODES = 50_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ajv = new (Ajv2020 as any)({
  allErrors: true,
  strict: true,
  strictTypes: true,
  strictTuples: true,
  strictRequired: true,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(addFormats as any)(ajv);

// JSON Schema files in this directory are the single source of truth (per ADR-003).
// Loaded at module init so validators are ready before first use.
const configSchema: object = JSON.parse(readFileSync(join(__dirname, 'config.v1.json'), 'utf8'));
const stateSchema: object = JSON.parse(readFileSync(join(__dirname, 'state.v1.json'), 'utf8'));

const validateConfigFn = ajv.compile(configSchema);
const validateStateFn = ajv.compile(stateSchema);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors) return [];
  return errors.map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'unknown error'}`);
}

/**
 * Walk `data` and return { tooDeep, tooLarge } if either limit is hit.
 * Short-circuits on the first violation so adversarial inputs don't pay
 * a full traversal cost.
 */
function checkPayloadComplexity(data: unknown): { ok: true } | { ok: false; reason: string } {
  let nodes = 0;
  function walk(value: unknown, depth: number): boolean {
    if (depth > MAX_PAYLOAD_DEPTH) {
      throw new Error(`payload depth exceeds ${MAX_PAYLOAD_DEPTH}`);
    }
    nodes += 1;
    if (nodes > MAX_PAYLOAD_NODES) {
      throw new Error(`payload exceeds ${MAX_PAYLOAD_NODES} nodes`);
    }
    if (value === null || typeof value !== 'object') return true;
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1);
      return true;
    }
    for (const v of Object.values(value as Record<string, unknown>)) {
      walk(v, depth + 1);
    }
    return true;
  }
  try {
    walk(data, 0);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

export function validateConfig(data: unknown): ValidationResult {
  const guard = checkPayloadComplexity(data);
  if (!guard.ok) return { valid: false, errors: [`(root) ${guard.reason}`] };
  const valid = validateConfigFn(data) as boolean;
  return { valid, errors: valid ? [] : formatErrors(validateConfigFn.errors) };
}

export function validateState(data: unknown): ValidationResult {
  const guard = checkPayloadComplexity(data);
  if (!guard.ok) return { valid: false, errors: [`(root) ${guard.reason}`] };
  const valid = validateStateFn(data) as boolean;
  return { valid, errors: valid ? [] : formatErrors(validateStateFn.errors) };
}

// Re-exported for tests / Phase 6 logging diagnostics.
export const _internals = {
  MAX_PAYLOAD_DEPTH,
  MAX_PAYLOAD_NODES,
  checkPayloadComplexity,
};
