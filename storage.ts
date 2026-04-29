/**
 * storage.ts — Project-local JSONL-backed memory store for pi-memoir.
 *
 * Stores memories as append-only JSONL at <project>/.pi/memoir/memories.jsonl.
 * Each entry: { id, timestamp, content, summary, tags[], scope, source }
 *
 * Search uses keyword matching across content, summary, and tags with
 * simple TF term scoring for relevance ranking.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ──────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  timestamp: string; // ISO 8601
  content: string;
  summary: string;
  tags: string[];
  scope: string;
  source: "manual" | "auto" | "tool";
}

export interface SearchOptions {
  tags?: string[];
  scope?: string;
  limit?: number;
  includeContent?: boolean;
}

export interface SearchResult {
  entry: MemoryEntry;
  score: number;
  preview: string;
}

// ─── ID Generation ──────────────────────────────────────────────────

let counter = 0;

function generateId(): string {
  const ts = Date.now().toString(36);
  counter++;
  return `${ts}-${counter.toString(36).padStart(4, "0")}`;
}

// ─── Storage Class ──────────────────────────────────────────────────

export class MemoryStore {
  private entries: MemoryEntry[] = [];
  private loaded = false;
  private baseDir = "";
  private storeDir = "";
  private storeFile = "";

  /**
   * Initialize the store for a given project directory.
   * Memories are stored at <baseDir>/.pi/memoir/memories.jsonl
   * If no baseDir is given, uses process.cwd().
   */
  async init(baseDir?: string): Promise<void> {
    this.baseDir = baseDir ?? process.cwd();
    this.storeDir = path.join(this.baseDir, ".pi", "memoir");
    this.storeFile = path.join(this.storeDir, "memories.jsonl");
    fs.mkdirSync(this.storeDir, { recursive: true });
    await this.load();
  }

  /** The storage directory path (for display / info). */
  get directory(): string {
    return this.storeDir;
  }

  /** The project base directory. */
  get projectDir(): string {
    return this.baseDir;
  }

  /** Load all entries from the JSONL file into memory. */
  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = fs.readFileSync(this.storeFile, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      this.entries = lines.map((line) => JSON.parse(line) as MemoryEntry);
    } catch {
      // File doesn't exist yet — that's fine
      this.entries = [];
    }
    this.loaded = true;
  }

  /** Append a new memory entry. Returns the entry ID. */
  async store(opts: {
    content: string;
    summary?: string;
    tags?: string[];
    scope?: string;
    source?: "manual" | "auto" | "tool";
  }): Promise<string> {
    await this.load();

    const entry: MemoryEntry = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      content: opts.content,
      summary: opts.summary ?? opts.content.slice(0, 80),
      tags: opts.tags ?? [],
      scope: opts.scope ?? "global",
      source: opts.source ?? "manual",
    };

    this.entries.push(entry);

    // Append to JSONL file
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(this.storeFile, line, "utf-8");

    return entry.id;
  }

  /** Search memories by keyword matching against content, summary, and tags. */
  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    await this.load();

    const limit = opts?.limit ?? 10;
    const lowerQuery = query.toLowerCase();
    const queryTerms = lowerQuery.split(/\s+/).filter((t) => t.length > 0);

    if (queryTerms.length === 0) return [];

    // Score each entry by term frequency
    const scored = this.entries
      .filter((e) => {
        if (opts?.tags && opts.tags.length > 0) {
          const hasAllTags = opts.tags.every((t) => e.tags.includes(t));
          if (!hasAllTags) return false;
        }
        if (opts?.scope && e.scope !== opts.scope) return false;
        return true;
      })
      .map((entry) => {
        const searchable = [
          entry.content.toLowerCase(),
          entry.summary.toLowerCase(),
          ...entry.tags.map((t) => t.toLowerCase()),
        ].join(" ");

        let score = 0;
        for (const term of queryTerms) {
          // Exact word boundary match = higher score
          const wordRegex = new RegExp(`\\b${term}\\b`, "gi");
          const wordMatches = searchable.match(wordRegex);
          if (wordMatches) score += wordMatches.length * 2;

          // Substring match = lower score
          const subMatches = searchable.split(term).length - 1;
          score += subMatches;
        }

        return { entry, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map((r) => ({
      entry: r.entry,
      score: r.score,
      preview: opts?.includeContent !== false ? r.entry.content.slice(0, 200) : r.entry.summary,
    }));
  }

  /** List recent entries, optionally filtered by tags/scope. Returns newest first. */
  async list(opts?: { tags?: string[]; scope?: string; limit?: number }): Promise<MemoryEntry[]> {
    await this.load();

    let filtered = this.entries;
    if (opts?.tags && opts.tags.length > 0) {
      filtered = filtered.filter((e) => opts.tags!.every((t) => e.tags.includes(t)));
    }
    if (opts?.scope) {
      filtered = filtered.filter((e) => e.scope === opts.scope);
    }

    const limit = opts?.limit ?? 20;
    // Return in reverse chronological order (newest first)
    return [...filtered].reverse().slice(0, limit);
  }

  /** Delete a memory by ID. Returns true if found and deleted. */
  async delete(id: string): Promise<boolean> {
    await this.load();
    const index = this.entries.findIndex((e) => e.id === id);
    if (index === -1) return false;
    this.entries.splice(index, 1);
    await this.persist();
    return true;
  }

  /** Delete a memory by its 1-based index in the current list (newest = 1). */
  async deleteByIndex(index: number): Promise<boolean> {
    await this.load();
    if (index < 1 || index > this.entries.length) return false;
    const sorted = [...this.entries].reverse(); // newest first
    const entry = sorted[index - 1];
    return this.delete(entry.id);
  }

  /** Get total stored entry count. */
  async count(): Promise<number> {
    await this.load();
    return this.entries.length;
  }

  /** Full rewrite of the JSONL file (used after delete). */
  private async persist(): Promise<void> {
    const lines = this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(this.storeFile, lines, "utf-8");
  }
}

/** Singleton store instance shared across the extension. */
export const store = new MemoryStore();
