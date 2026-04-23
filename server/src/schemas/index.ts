import Ajv2020, { ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ajv = new (Ajv2020 as any)({ allErrors: true });
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

export function validateConfig(data: unknown): ValidationResult {
  const valid = validateConfigFn(data) as boolean;
  return { valid, errors: valid ? [] : formatErrors(validateConfigFn.errors) };
}

export function validateState(data: unknown): ValidationResult {
  const valid = validateStateFn(data) as boolean;
  return { valid, errors: valid ? [] : formatErrors(validateStateFn.errors) };
}
