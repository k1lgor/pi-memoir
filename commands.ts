/**
 * commands.ts — /memo command for pi-memoir.
 *
 * Uses ctx.ui.setWidget() for list/search display (refreshes on mutations)
 * and ctx.ui.notify() for short status messages.
 * Widgets are cleared on agent_start (see hooks.ts).
 *
 * Subcommands:
 *   /memo store <text> [--tags t1,t2]
 *   /memo search <query> [--tags t1] [--limit N]
 *   /memo list [--tags t1] [--limit N]
 *   /memo delete <id|number>
 *   /memo harvest
 *   /memo stats
 *   /memo path
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { store } from "./storage";
import { harvestProject } from "./harvester";

// ─── Command Handler ────────────────────────────────────────────────

export function registerCommand(pi: ExtensionAPI): void {
  pi.registerCommand("memo", {
    description:
      "Pi-memoir: persistent project memory. Subcommands: store, search, list, delete, harvest, stats, path",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length === 0 || parts[0] === "") {
        ctx.ui.notify(
          "Usage: /memo <store|search|list|delete|harvest|stats|path>",
          "info",
        );
        return;
      }

      const subcommand = parts[0].toLowerCase();

      switch (subcommand) {
        case "store":
          await handleStore(parts.slice(1), ctx);
          break;
        case "search":
          await handleSearch(parts.slice(1), ctx);
          break;
        case "list":
          await handleList(parts.slice(1), ctx);
          break;
        case "delete":
          await handleDelete(parts.slice(1), ctx);
          break;
        case "harvest":
          await handleHarvest(ctx);
          break;
        case "stats":
          await handleStats(ctx);
          break;
        case "path":
          await handlePath(ctx);
          break;
        default:
          ctx.ui.notify(
            `Unknown subcommand: ${subcommand}. Use: store, search, list, delete, harvest, stats, path`,
            "error",
          );
      }
    },
  });
}

// ─── Widget Helpers ─────────────────────────────────────────────────
async function refreshListWidget(ctx: ExtensionCommandContext): Promise<void> {
  const entries = await store.list({ limit: 50 });
  if (entries.length === 0) {
    ctx.ui.setWidget("memo-list", undefined);
  } else {
    const lines: string[] = [];
    lines.push(`── Memories (${entries.length}) ──`);
    entries.forEach((e, i) => {
      const tagsStr = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
      lines.push(
        `  ${i + 1}. ${e.summary}${tagsStr} (${e.timestamp.slice(0, 10)})`,
      );
    });
    lines.push(`── /memo delete <number> to remove ──`);
    ctx.ui.setWidget("memo-list", lines);
  }
}

// ─── Subcommand Handlers ────────────────────────────────────────────

async function handleStore(
  args: string[],
  ctx: ExtensionCommandContext,
): Promise<void> {
  const parsed = parseFlags(args);
  if (parsed.positional.length === 0) {
    ctx.ui.notify("Usage: /memo store <text> [--tags t1,t2]", "error");
    return;
  }

  const tags = parsed.flags.tags
    ? parsed.flags.tags
        .split(",")
        .map((t: string) => t.trim())
        .filter(Boolean)
    : [];

  const content = parsed.positional.join(" ");
  const id = await store.store({ content, tags, source: "manual" });
  const count = await store.count();

  // Refresh the list widget to include the new memory
  await refreshListWidget(ctx);
  ctx.ui.notify(
    `✅ Memory stored (id: ${id}). Total: ${count} memories.`,
    "success",
  );
}

async function handleSearch(
  args: string[],
  ctx: ExtensionCommandContext,
): Promise<void> {
  const parsed = parseFlags(args);
  if (parsed.positional.length === 0) {
    ctx.ui.notify(
      "Usage: /memo search <query> [--tags t1] [--limit N]",
      "error",
    );
    return;
  }

  const tags = parsed.flags.tags
    ? parsed.flags.tags
        .split(",")
        .map((t: string) => t.trim())
        .filter(Boolean)
    : undefined;
  const limit = parsed.flags.limit ? parseInt(parsed.flags.limit, 10) : 10;

  const results = await store.search(parsed.positional.join(" "), {
    tags,
    limit,
  });

  if (results.length === 0) {
    ctx.ui.setWidget("memo-search", undefined);
    ctx.ui.notify(
      "No matching memories found. Use /memo harvest to build project knowledge.",
      "info",
    );
    return;
  }

  const lines: string[] = [];
  lines.push(
    `── Search: "${parsed.positional.join(" ")}" (${results.length}) ──`,
  );
  results.forEach((r, i) => {
    const tagsStr =
      r.entry.tags.length > 0 ? ` [${r.entry.tags.join(", ")}]` : "";
    lines.push(`  ${i + 1}. ${r.entry.summary} (score: ${r.score})${tagsStr}`);
    lines.push(`     ${r.preview}`);
  });
  lines.push(`── End ──`);
  ctx.ui.setWidget("memo-search", lines);
}

async function handleList(
  args: string[],
  ctx: ExtensionCommandContext,
): Promise<void> {
  const parsed = parseFlags(args);
  const tags = parsed.flags.tags
    ? parsed.flags.tags
        .split(",")
        .map((t: string) => t.trim())
        .filter(Boolean)
    : undefined;
  const limit = parsed.flags.limit ? parseInt(parsed.flags.limit, 10) : 20;

  const entries = await store.list({ tags, limit });

  if (entries.length === 0) {
    ctx.ui.notify(
      "No memories stored yet. Use /memo harvest to scan the project.",
      "info",
    );
    return;
  }

  const msg = [`── Memories (${entries.length}) ──`];
  entries.forEach((e, i) => {
    const tagsStr = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
    msg.push(
      `  ${i + 1}. ${e.summary}${tagsStr} (${e.timestamp.slice(0, 10)})`,
    );
  });
  msg.push(`── /memo delete <number> to remove ──`);
  ctx.ui.notify(msg.join("\n"), "info");
}

async function handleDelete(
  args: string[],
  ctx: ExtensionCommandContext,
): Promise<void> {
  // Check for --all / -a flag
  const parsed = parseFlags(args);
  if (parsed.flags["all"] === "true" || parsed.flags["a"] === "true") {
    const count = await store.count();
    if (count === 0) {
      ctx.ui.notify("No memories to delete.", "info");
      return;
    }
    // Confirm with user
    let confirmed = false;
    if (ctx.hasUI) {
      confirmed = await ctx.ui.confirm(
        "Delete all?",
        `Delete all ${count} memories? This cannot be undone.`,
      );
    } else {
      // Print mode — no interactive confirm
      confirmed = true;
    }
    if (!confirmed) {
      ctx.ui.notify("Cancelled.", "info");
      return;
    }
    // Delete all memories
    const entries = await store.list({ limit: 1000 });
    let deleted = 0;
    for (const entry of entries) {
      const removed = await store.delete(entry.id);
      if (removed) deleted++;
    }
    ctx.ui.setWidget("memo-list", undefined);
    ctx.ui.setWidget("memo-search", undefined);
    ctx.ui.notify(`🗑️ Deleted all ${deleted} memories.`, "success");
    return;
  }

  if (parsed.positional.length === 0) {
    ctx.ui.notify(
      "Usage: /memo delete <id|number>  or  /memo delete --all (-a)",
      "error",
    );
    return;
  }

  const input = parsed.positional[0];

  if (/^\d+$/.test(input)) {
    const index = parseInt(input, 10);
    const ok = await store.deleteByIndex(index);
    if (ok) {
      const count = await store.count();
      // Refresh widget with updated list
      await refreshListWidget(ctx);
      ctx.ui.notify(
        `Deleted memory #${index}. ${count} memories remaining.`,
        "success",
      );
    } else {
      ctx.ui.notify(
        `Invalid index: ${index}. Use /memo list to see valid indices.`,
        "error",
      );
    }
  } else {
    const ok = await store.delete(input);
    if (ok) {
      const count = await store.count();
      // Refresh widget with updated list
      await refreshListWidget(ctx);
      ctx.ui.notify(
        `Deleted memory ${input}. ${count} memories remaining.`,
        "success",
      );
    } else {
      ctx.ui.notify(
        `Memory ${input} not found. Use /memo list to see IDs.`,
        "error",
      );
    }
  }
}

async function handleHarvest(ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.notify("🔍 Harvesting project knowledge...", "info");
  const count = await harvestProject(store.projectDir);
  ctx.ui.notify(
    `✅ Harvested ${count} new memories about the project.`,
    "success",
  );
}

async function handleStats(ctx: ExtensionCommandContext): Promise<void> {
  const count = await store.count();
  ctx.ui.notify(
    `🧠 pi-memoir: ${count} memories at ${store.directory}`,
    "info",
  );
}

async function handlePath(ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.notify(`📁 ${store.directory}`, "info");
}

// ─── Flag Parser ────────────────────────────────────────────────────

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

function parseFlags(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--all" || arg === "-a") {
      flags["all"] = "true";
      flags["a"] = "true";
    } else if (arg.startsWith("--")) {
      const flagName = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[flagName] = args[i + 1];
        i++;
      } else {
        flags[flagName] = "true";
      }
    } else if (/^-[a-zA-Z]$/.test(arg)) {
      // Short flag: -a, -t, etc.
      flags[arg[1]] = "true";
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}
