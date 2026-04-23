import Ajv2020, { ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ajv = new (Ajv2020 as any)({ allErrors: true });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(addFormats as any)(ajv);

const configSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/epiphytic/hotskills/schemas/config.v1.json',
  title: 'Hotskills Config v1',
  type: 'object',
  required: ['version'],
  additionalProperties: false,
  properties: {
    version: { type: 'integer', const: 1 },
    mode: { type: 'string', enum: ['interactive', 'auto', 'opportunistic'] },
    opportunistic: { type: 'boolean' },
    activated: {
      type: 'array',
      items: {
        type: 'object',
        required: ['skill_id', 'activated_at'],
        additionalProperties: false,
        properties: {
          skill_id: { type: 'string', pattern: '^(skills\\.sh|github|git):[^/]+/[^:]+:.+$' },
          activated_at: { type: 'string', format: 'date-time' },
          description: { type: 'string', maxLength: 80 },
        },
      },
    },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'owner', 'repo'],
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['github', 'git'] },
          owner: { type: 'string' },
          repo: { type: 'string' },
          branch: { type: 'string' },
          preferred: { type: 'boolean' },
        },
      },
    },
    security: {
      type: 'object',
      additionalProperties: false,
      properties: {
        risk_max: { type: 'string', enum: ['safe', 'low', 'medium', 'high', 'critical'] },
        min_installs: { type: 'integer', minimum: 0 },
        audit_partners: { type: 'array', items: { type: 'string' } },
        audit_conflict_resolution: { type: 'string', enum: ['max', 'mean', 'majority'] },
        no_audit_data_policy: {
          type: 'string',
          enum: ['fallback_to_installs', 'block', 'allow_with_warning'],
        },
        preferred_sources: { type: 'array', items: { type: 'string' } },
        whitelist: {
          type: 'object',
          additionalProperties: false,
          properties: {
            orgs: { type: 'array', items: { type: 'string' } },
            repos: { type: 'array', items: { type: 'string' } },
            skills: { type: 'array', items: { type: 'string' } },
          },
        },
        heuristic: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            patterns: {
              type: 'object',
              additionalProperties: false,
              properties: {
                broad_bash_glob: { type: 'boolean' },
                write_outside_cwd: { type: 'boolean' },
                curl_pipe_sh: { type: 'boolean' },
                raw_network_egress: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
    cache: {
      type: 'object',
      additionalProperties: false,
      properties: {
        search_ttl_seconds: { type: 'integer', minimum: 0 },
        audit_ttl_seconds: { type: 'integer', minimum: 0 },
        skills_ttl_seconds: { type: 'integer', minimum: 0 },
      },
    },
  },
};

const stateSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/epiphytic/hotskills/schemas/state.v1.json',
  title: 'Hotskills State v1',
  type: 'object',
  required: ['version', 'opportunistic_pending', 'session_id'],
  additionalProperties: false,
  properties: {
    version: { type: 'integer', const: 1 },
    opportunistic_pending: { type: 'boolean' },
    session_id: { type: 'string' },
    last_compact_at: { oneOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
    last_session_start_at: { oneOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
  },
};

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
