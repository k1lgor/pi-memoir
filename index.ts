/**
 * index.ts — pi-memoir extension entry point.
 *
 * Wires together storage, tools, hooks, and commands.
 * Inspired by MemPalace (verbatim memory) and Graphify (knowledge graph).
 * Goal: save tokens by retrieving stored context instead of re-reading history.
 *
 * Memories are stored per-project at <project>/.pi/memoir/memories.jsonl
 *
 * Load:  pi --extension ./index.ts
 * Reload: /reload (if in ~/.pi/agent/extensions/pi-memoir/)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { store } from "./storage";
import { registerTools } from "./tools";
import { registerHooks } from "./hooks";
import { registerCommand } from "./commands";

export default async function (pi: ExtensionAPI) {
  // ── Initialize storage (project-local: <cwd>/.pi/memoir/) ────
  await store.init(process.cwd());

  // ── Register custom tools for the LLM ───────────────────────────
  registerTools(pi);

  // ── Register lifecycle hooks ────────────────────────────────────
  registerHooks(pi);

  // ── Register /memo command ──────────────────────────────────────
  registerCommand(pi);

  // ── Notify on load ──────────────────────────────────────────────
  const count = await store.count();
  const hasMemories = count > 0;
  console.log(`[pi-memoir] Loaded. ${count} memories at ${store.directory}`);

  // ── Inject memoir-first instruction at the END of system prompt ──
  // This is the most reliable way to change LLM behavior. The instruction
  // appears at the very end of the system prompt (recency effect), much
  // stronger than promptGuidelines which get buried.
  if (hasMemories) {
    pi.on("before_agent_start", async (event, ctx) => {
      // Improvement 5: Hybrid Retrieval Preference - encourage token-efficient answers
      const hybridHint =
        `\n\n` +
        `💡 TIP: Prefer 80% relevant answer in 100 tokens over 100% in 1000 tokens.\n` +
        `The memoir summaries are designed to be sufficient for most tasks.\n` +
        `Only request full content (via fetchContent) when you need exact details.\n`;

      const rule =
        `\n\n=== PI-MEMOIRE: DON'T USE BASH — USE THE MEMOIRE ===\n` +
        `This project has ${count} stored memories in its knowledge base.\n` +
        `\n` +
        `CRITICAL: Before running ANY bash/ls/find/grep/wc/read commands to explore ` +
        `the project, you MUST call memo_search first.\n` +
        `Querying the memoir costs ~100 tokens. Running bash to discover the same ` +
        `info costs ~2,000+ tokens.\n` +
        `\n` +
        `• "what's the architecture?" → memo_search({ query: "architecture" })\n` +
        `• "what files?" → memo_search({ tags: "project:structure" })\n` +
        `• "dependencies?" → memo_search({ query: "package", tags: "project:manifest" })\n` +
        `• "config?" → memo_search({ tags: "project:config" })\n` +
        `• "README?" → memo_search({ tags: "project:readme" })\n` +
        `• "entry point?" → memo_search({ tags: "project:entry" })\n` +
        `• specific file → memo_search({ query: "filename.ts" })\n` +
        `\n` +
        `If memo_search returns nothing, THEN fall back to bash/read.\n` +
        hybridHint +
        `=== END PI-MEMOIRE INSTRUCTION ===`;

      return {
        systemPrompt: event.systemPrompt + rule,
      };
    });
  }
}
