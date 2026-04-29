/**
 * tools.ts — Custom pi tools for pi-memoir.
 *
 * Three tools:
 *   - memo_store:    Store a memory (fact, decision, finding)
 *   - memo_search:   Search stored memories (project knowledge, past decisions)
 *   - memo_harvest:  Scan project and build knowledge base
 *
 * Core philosophy: use memoir instead of reading all project files.
 * Before reading a file to understand the project, search the memoir first.
 * This saves significant tokens by avoiding redundant file reads.
 */

import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { store } from "./storage";
import { harvestProject } from "./harvester";

// ─── Tool: memo_store ───────────────────────────────────────────────

const memoStoreParams = Type.Object({
  content: Type.String({ description: "The memory content to store (what you want to remember)" }),
  summary: Type.Optional(Type.String({ description: "A short summary/headline (default: first 80 chars of content)" })),
  tags: Type.Optional(Type.String({ description: "Comma-separated tags for categorization, e.g. 'architecture,decision,config' or 'project:overview'" })),
});

const memoStoreTool: ToolDefinition<typeof memoStoreParams> = {
  name: "memo_store",
  label: "Memo: Store Memory",
  description:
    "Store a memory that persists across pi sessions. Use this to save important decisions, " +
    "architecture choices, project facts, and findings. Tag with relevant categories. " +
    "The project harvester (memo_harvest) stores structured project knowledge — use this " +
    "for additional/ad-hoc facts the LLM or user wants to remember.",
  promptSnippet: "Store a memory for future recall",
  promptGuidelines: [
    "Use memo_store when the user mentions an important decision, architecture choice, or project fact they'll want to recall later.",
    "Use descriptive tags so memo_search can find the memory later (e.g., 'architecture', 'decision', 'config').",
  ],
  parameters: memoStoreParams,
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const tags = params.tags
      ? params.tags.split(",").map((t) => t.trim()).filter((t) => t.length > 0)
      : [];

    const id = await store.store({
      content: params.content,
      summary: params.summary,
      tags,
      source: "tool",
    });

    const count = await store.count();

    return {
      content: [
        {
          type: "text" as const,
          text: `✅ Memory stored (id: ${id}). You now have ${count} stored memories.${
            tags.length > 0 ? ` Tags: [${tags.join(", ")}]` : ""
          }`,
        },
      ],
      details: { memoryId: id, totalMemories: count, tags },
    };
  },
};

// ─── Tool: memo_search ──────────────────────────────────────────────

const memoSearchParams = Type.Object({
  query: Type.String({ description: "Search keywords to find relevant memories. Use project-specific terms like file names, architecture concepts, or tech stack names." }),
  tags: Type.Optional(Type.String({ description: "Optional: comma-separated tags to filter by (e.g. 'project:structure,project:config'). Only memories with ALL specified tags are returned." })),
  limit: Type.Optional(Type.Number({ description: "Maximum results to return (default: 5, max: 20)" })),
});

const memoSearchTool: ToolDefinition<typeof memoSearchParams> = {
  name: "memo_search",
  label: "Memo: Search Memory",
  description:
    "Search stored project memories. REPLACES bash/ls/find/grep/read for project exploration. " +
    "The memoir stores harvested project knowledge (structure, config, architecture, decisions). " +
    "Searching costs ~100 tokens. Running bash to discover the same info costs ~2,000+ tokens. " +
    "Results are ranked by relevance. Try different keyword phrasings if the first search returns nothing.",
  promptSnippet: "REPLACES bash/ls/read for project exploration — saves ~20x tokens",
  promptGuidelines: [
    "CRITICAL — DO NOT use bash/ls/find/grep/wc to explore the project structure. Call memo_search FIRST with appropriate keywords (e.g. 'architecture', 'structure', 'config', a file name).",
    "Use project-specific keywords: architecture concepts ('authentication', 'database'), file names ('server.ts', 'routes'), or tech stack ('React', 'Express').",
    "Use tag filters for precision: 'project:structure' for directory layout, 'project:config' for configuration, 'project:readme' for project overview.",
    "If memo_search returns nothing useful, call memo_harvest to scan and memorize the project, then search again.",
  ],
  parameters: memoSearchParams,
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const tags = params.tags
      ? params.tags.split(",").map((t) => t.trim()).filter((t) => t.length > 0)
      : undefined;

    const limit = Math.min(params.limit ?? 5, 20);

    const results = await store.search(params.query, { tags, limit });

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No matching memories found. The project may not have been harvested yet. Try:\n" +
                  "1. Run memo_harvest to scan and memorize the project\n" +
                  "2. Or try different search keywords",
          },
        ],
        details: { query: params.query, resultsCount: 0 },
      };
    }

    const lines = results.map((r, i) => {
      const tagsStr = r.entry.tags.length > 0 ? ` [${r.entry.tags.join(", ")}]` : "";
      return `${i + 1}. **${r.entry.summary}** (score: ${r.score})${tagsStr}\n   ${r.preview}`;
    });

    const total = await store.count();

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${results.length} matching memories (of ${total} total):\n\n${lines.join("\n\n")}`,
        },
      ],
      details: {
        query: params.query,
        resultsCount: results.length,
        totalMemories: total,
        results: results.map((r) => ({
          id: r.entry.id,
          summary: r.entry.summary,
          score: r.score,
          tags: r.entry.tags,
          timestamp: r.entry.timestamp,
        })),
      },
    };
  },
};

// ─── Tool: memo_harvest ─────────────────────────────────────────────

const memoHarvestParams = Type.Object({});

const memoHarvestTool: ToolDefinition<typeof memoHarvestParams> = {
  name: "memo_harvest",
  label: "Memo: Harvest Project Knowledge",
  description:
    "Scan the entire project directory and build a structured knowledge base: " +
    "directory structure, key files (README, package.json, configs), entry points, " +
    "dependencies, AND every individual source file (.ts, .js, .py, .rs, .md, etc.). " +
    "Store all of this as searchable memories. Run this once at the start of working with a new project. " +
    "After harvesting, you can query project knowledge with memo_search instead of reading all files. " +
    "Skips node_modules, .git, dist, and files > 20KB. Caps at 200 file memories.",
  promptSnippet: "Scan and memorize the entire project (replaces reading all files)",
  promptGuidelines: [
    "Run memo_harvest ONCE when starting work on a new project to build the knowledge base. After that, use memo_search instead.",
    "After harvesting, do NOT run bash/ls/find/grep to explore the project — use memo_search with tag filters.",
    "Each source file gets its own memory tagged with 'project:file' and 'file:<path>'. Search by filename tags for precision.",
  ],
  parameters: memoHarvestParams,
  async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
    const count = await harvestProject(store.projectDir);

    return {
      content: [
        {
          type: "text" as const,
          text: count > 0
            ? `✅ Harvested ${count} new memories about the project. You can now use memo_search to query project knowledge instead of reading files.`
            : "No new memories were harvested. The project may already be up to date.",
        },
      ],
      details: { harvested: count, projectDir: store.projectDir },
    };
  },
};

// ─── Registration ───────────────────────────────────────────────────

export function registerTools(pi: ExtensionAPI): void {
  pi.registerTool(memoStoreTool);
  pi.registerTool(memoSearchTool);
  pi.registerTool(memoHarvestTool);
}
