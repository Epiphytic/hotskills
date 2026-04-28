// vendored-from-START
// Source: https://github.com/vercel-labs/skills (src/find.ts)
// Sync SHA: bc21a37a12b90fcb5aec051c91baf5b227b704b1 (tag v1.5.1)
// Sync date: 2026-04-23
// License: MIT (see ./LICENSE)
// Modifications: extracted only the API search function and its types.
//   The interactive runFind, runSearchPrompt, ANSI helpers, readline TTY
//   handling, and telemetry track() calls are removed because the
//   hotskills MCP server is non-interactive by definition.
//   See ./patches/find-extract-search-api.patch.
// vendored-from-END

// API endpoint for skills search
const SEARCH_API_BASE = process.env.SKILLS_API_URL || 'https://skills.sh';

export interface SearchSkill {
  name: string;
  slug: string;
  source: string;
  installs: number;
}

// Search via API
export async function searchSkillsAPI(query: string): Promise<SearchSkill[]> {
  try {
    const url = `${SEARCH_API_BASE}/api/search?q=${encodeURIComponent(query)}&limit=10`;
    const res = await fetch(url);

    if (!res.ok) return [];

    const data = (await res.json()) as {
      skills: Array<{
        id: string;
        name: string;
        installs: number;
        source: string;
      }>;
    };

    return data.skills
      .map((skill) => ({
        name: skill.name,
        slug: skill.id,
        source: skill.source || '',
        installs: skill.installs,
      }))
      .sort((a, b) => (b.installs || 0) - (a.installs || 0));
  } catch {
    return [];
  }
}
