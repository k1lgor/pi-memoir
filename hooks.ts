/**
 * hooks.ts — Lifecycle hooks for pi-memoir.
 *
 * - session_shutdown: Auto-store a condensed memory of the session's key decisions.
 * - session_start: Optionally load relevant memories for context injection.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { store } from "./storage";
import { harvestProject } from "./harvester";

// ─── Helpers ─────────────────────────────────────────────────────────

/** Extract a project name from a cwd path. */
function projectName(cwd: string): string {
  return cwd.split(/[/\\]/).filter(Boolean).pop() ?? "unknown";
}

/** Decide if a session shutdown should trigger auto-store. */
function shouldAutoStore(ctx: ExtensionContext): boolean {
  // Skip auto-store for quit/reload (only for new/resume/fork where context might be lost)
  // We just check if we have entries
  return true;
}

// ─── Hook Registrations ─────────────────────────────────────────────

export function registerHooks(pi: ExtensionAPI): void {
  // ── Clear memo widgets when a new user prompt arrives ──────────
  pi.on("agent_start", async (_event, ctx) => {
    ctx.ui.setWidget("memo-list", undefined);
    ctx.ui.setWidget("memo-search", undefined);
  });

  // ── On session start: auto-harvest if no project knowledge ────
  pi.on("session_start", async (_event, ctx) => {
    const projectMemories = await store.list({ tags: ["project"], limit: 1 });
    if (projectMemories.length === 0) {
      console.log("[pi-memoir] No project knowledge found. Auto-harvesting...");
      const count = await harvestProject(store.projectDir);
      console.log(
        `[pi-memoir] Auto-harvested ${count} memories. Use memo_search to query them.`,
      );
    } else {
      const count = await store.count();
      console.log(
        `[pi-memoir] ${count} memories loaded. Use memo_search to query them.`,
      );
    }
  });

  // ── Auto-store on session shutdown ──────────────────────────────
  pi.on("session_shutdown", async (event, ctx) => {
    if (!shouldAutoStore(ctx)) return;

    const entries = ctx.sessionManager.getEntries();

    // Look for significant events in recent entries (last 10)
    const recentEntries = entries.slice(-10);
    const significantMoments: string[] = [];

    for (const entry of recentEntries) {
      // Tool entries with write/edit operations are significant
      if (entry.type === "toolResult" && entry.data?.toolName === "edit") {
        significantMoments.push(
          `Edited file: ${entry.data.input?.path ?? "unknown"}`,
        );
      }
      if (entry.type === "toolResult" && entry.data?.toolName === "write") {
        significantMoments.push(
          `Created file: ${entry.data.input?.path ?? "unknown"}`,
        );
      }
      // User messages that contain decisions
      if (entry.type === "user" && entry.data?.content) {
        const text = extractText(entry.data.content);
        if (text && isDecisionText(text)) {
          significantMoments.push(`Decision: ${text.slice(0, 150)}`);
        }
      }
    }

    if (significantMoments.length === 0) return;

    const scope = projectName(ctx.cwd);
    const summary = `Session summary — ${significantMoments.length} key moments`;
    const content = significantMoments.join("\n");

    await store.store({
      content,
      summary,
      tags: ["auto", "session-end", scope],
      scope,
      source: "auto",
    });
  });

  // ── Context injection on session start (opt-in via config) ─────
  // Currently commented out — enable when auto-injection is desired.
  // The concern is token cost: injected memories cost tokens every turn.
  //
  // pi.on("session_start", async (_event, ctx) => {
  //   const scope = projectName(ctx.cwd);
  //   const results = await store.search(scope, { scope, limit: 3 });
  //   if (results.length === 0) return;
  //   // TODO: inject as custom message with display: false
  //   // This needs pi's sendMessage API or before_agent_start injection
  // });
}

// ─── Text Extraction ────────────────────────────────────────────────

/** Extract plain text from a message content array (or string). */
function extractText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (
      content
        .map((part: Record<string, unknown>) =>
          part.type === "text" ? String(part.text ?? "") : "",
        )
        .filter(Boolean)
        .join(" ")
        .trim() || null
    );
  }
  return null;
}

/** Rough heuristic: does this text sound like a decision or important fact? */
function isDecisionText(text: string): boolean {
  const decisionIndicators = [
    /(we|i|let's|we'll|we should|we need) (use|switch|migrate|adopt|implement|change)/i,
    /(decided|decision|conclusion|agreed|chosen|selected)/i,
    /(architecture|pattern|approach|strategy|design) (is|will be|should be)/i,
    /using \w+ for/i,
    /migrat(e|ion) (from|to)/i,
  ];
  return decisionIndicators.some((re) => re.test(text));
}
