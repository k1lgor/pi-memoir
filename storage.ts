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
  lastModified?: string; // ISO 8601 - for staleness tracking (Imp 2)
  content: string;
  summary: string;
  tags: string[];
  scope: string;
  source: "manual" | "auto" | "tool";
  // Improvement 3: Lazy Harvesting
  isMetadataOnly?: boolean; // true if content not yet harvested
  originalFilePath?: string; // path for on-demand content retrieval
}

export interface SearchOptions {
  tags?: string[];
  scope?: string;
  limit?: number;
  includeContent?: boolean;
  // Improvement 2: Staleness-Based Filtering
  expireDays?: number;
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
  /**
   * Improvement 2: Check if entry is older than expireDays
   */
  private isExpired(entry: MemoryEntry, expireDays: number): boolean {
    const lastMod = entry.lastModified || entry.timestamp;
    const lastModDate = new Date(lastMod);
    const now = new Date();
    const diffMs = now.getTime() - lastModDate.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    return diffDays > expireDays;
  }

  async store(opts: {
    content: string;
    summary?: string;
    tags?: string[];
    scope?: string;
    source?: "manual" | "auto" | "tool";
    // Improvement 3: Lazy Harvesting
    isMetadataOnly?: boolean;
    originalFilePath?: string;
  }): Promise<string> {
    await this.load();

    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: generateId(),
      timestamp: now,
      lastModified: now, // Track last modification time
      content: opts.content,
      summary: opts.summary ?? opts.content.slice(0, 80),
      tags: opts.tags ?? [],
      scope: opts.scope ?? "global",
      source: opts.source ?? "manual",
      // Improvement 3: Lazy Harvesting
      isMetadataOnly: opts.isMetadataOnly ?? false,
      originalFilePath: opts.originalFilePath,
    };

    this.entries.push(entry);

    // Append to JSONL file
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(this.storeFile, line, "utf-8");

    return entry.id;
  }

  /**
   * Improvement 3: Lazy Harvesting - fetch full content on demand
   * If content is metadata-only, try to read from originalFilePath
   */
  async fetchContent(id: string): Promise<string | null> {
    await this.load();
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return null;

    // If content already available, return it
    if (entry.content && !entry.isMetadataOnly) {
      return entry.content;
    }

    // Try to read from original file path
    if (entry.originalFilePath && entry.isMetadataOnly) {
      try {
        const content = fs.readFileSync(entry.originalFilePath, "utf-8");
        // Update entry with full content
        entry.content = content;
        entry.isMetadataOnly = false;
        entry.lastModified = new Date().toISOString();
        await this.persist();
        return content;
      } catch {
        return null;
      }
    }

    return entry.content;
  }

  /**
   * Improvement 2: Auto-expire old memories
   * @returns number of entries pruned
   */
  async pruneExpired(expireDays: number): Promise<number> {
    await this.load();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !this.isExpired(e, expireDays));
    const pruned = before - this.entries.length;
    if (pruned > 0) {
      await this.persist();
    }
    return pruned;
  }

  /** Search memories by keyword matching against content, summary, and tags. */
  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    await this.load();

    // Improvement 1: Query-Result Compression - default to 5 results
    const limit = opts?.limit ?? 5;
    const lowerQuery = query.toLowerCase();
    const queryTerms = lowerQuery.split(/\s+/).filter((t) => t.length > 0);

    if (queryTerms.length === 0) return [];

    // Score each entry by term frequency
    const scored = this.entries
      .filter((e) => {
        // Improvement 2: Staleness-Based Filtering
        if (opts?.expireDays && this.isExpired(e, opts.expireDays)) {
          return false;
        }
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

    // Improvement 1: Query-Result Compression - always use summary for smaller output
    return scored.map((r) => ({
      entry: r.entry,
      score: r.score,
      preview: r.entry.summary,
    }));
  }

  /** List recent entries, optionally filtered by tags/scope. Returns newest first. */
  async list(opts?: {
    tags?: string[];
    scope?: string;
    limit?: number;
  }): Promise<MemoryEntry[]> {
    await this.load();

    let filtered = this.entries;
    if (opts?.tags && opts.tags.length > 0) {
      filtered = filtered.filter((e) =>
        opts.tags!.every((t) => e.tags.includes(t)),
      );
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
