/**
 * Home page topic groups.
 * Posts are mapped by slug first; new posts without an entry fall back to
 * their tags. Post Markdown is never edited for this.
 */
export const POST_GROUPS = ["后端", "AI", "游戏 Mod", "自托管"] as const;
export type PostGroup = (typeof POST_GROUPS)[number] | "其他";

const BY_SLUG: Record<string, PostGroup> = {
  "building-shortlink-service": "后端",
  "shorlink-update": "后端",
  "shortlink-click-stats-kafka": "后端",
  "shortlink-redis-cache-ratelimit": "后端",
  "wecom-decrypt-padding-bug": "后端",
  "ai-novel-generator-v2": "AI",
  "ai-novel-planner": "AI",
  "finetuned-webnovel-model-and-ai-writing-thoughts": "AI",
  "modal-sglang-qwen35-multilora-deploy-retrospective": "AI",
  "claude-code-go": "AI",
  "claude-code-codex-collab-setup-notes": "AI",
  "owl-memory-system-design": "AI",
  "llm-client-minimal-implementation": "AI",
  "register-openai": "AI",
  "sakura-card-visual-ownership": "游戏 Mod",
  "sakura-clear-card-mod-design": "游戏 Mod",
  "sakura-three-era-character": "游戏 Mod",
  "sigrun-combat-model-design": "游戏 Mod",
  "building-personal-website": "自托管",
  "migrate-to-artalk": "自托管",
};

const TAG_RULES: [PostGroup, string[]][] = [
  ["游戏 Mod", ["mod", "杀戮尖塔"]],
  ["自托管", ["建站", "docker", "caddy", "vps", "自托管"]],
  [
    "AI",
    ["ai", "llm", "agent", "claude code", "codex", "qwen", "modal", "sglang"],
  ],
  ["后端", ["go", "后端", "redis", "kafka"]],
];

export function groupOf(slug: string, tags: string[] = []): PostGroup {
  const mapped = BY_SLUG[slug];
  if (mapped) return mapped;
  const lower = tags.map((t) => t.toLowerCase());
  for (const [group, keys] of TAG_RULES) {
    if (keys.some((k) => lower.includes(k))) return group;
  }
  return "其他";
}
