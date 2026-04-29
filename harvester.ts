/**
 * harvester.ts — Project knowledge harvester for pi-memoir.
 *
 * Scans the project directory, extracts structured knowledge, and stores
 * it as memories that the LLM can query instead of reading all files.
 *
 * The goal: save tokens by letting the LLM ask "what's the project structure?"
 * instead of reading every file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { store } from "./storage";

// ─── Files & Directories to skip ────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "out",
  ".next", ".nuxt", ".cache", "target", "vendor", ".bun",
  ".oh-my-pi", ".pi", "__pycache__", ".venv", "env", ".env",
  "coverage", ".nyc_output",
]);

const SKIP_FILES = new Set([
  ".DS_Store", "thumbs.db", ".gitkeep", ".npmrc", ".yarnrc",
  ".prettierrc", ".eslintrc", ".editorconfig",
]);

// ─── Key files to read (by priority) ────────────────────────────────

interface KeyFile {
  priority: number;       // lower = read first
  filename: string;       // exact filename match
  tag: string;            // memory tag
  label: string;          // human-readable label
}

const KEY_FILES: KeyFile[] = [
  { priority: 1,  filename: "README.md",           tag: "project:readme",      label: "Project README" },
  { priority: 2,  filename: "package.json",         tag: "project:manifest",    label: "Package manifest" },
  { priority: 2,  filename: "Cargo.toml",           tag: "project:manifest",    label: "Cargo manifest" },
  { priority: 2,  filename: "pyproject.toml",       tag: "project:manifest",    label: "Python project" },
  { priority: 2,  filename: "go.mod",               tag: "project:manifest",    label: "Go module" },
  { priority: 3,  filename: "tsconfig.json",        tag: "project:config",      label: "TypeScript config" },
  { priority: 3,  filename: "tsconfig.app.json",    tag: "project:config",      label: "TypeScript app config" },
  { priority: 3,  filename: "tsconfig.node.json",   tag: "project:config",      label: "TypeScript node config" },
  { priority: 3,  filename: "composer.json",        tag: "project:manifest",    label: "Composer manifest" },
  { priority: 3,  filename: "Gemfile",              tag: "project:manifest",    label: "Gemfile" },
  { priority: 4,  filename: "Makefile",             tag: "project:build",       label: "Makefile" },
  { priority: 4,  filename: "Dockerfile",           tag: "project:infra",       label: "Dockerfile" },
  { priority: 4,  filename: "docker-compose.yml",   tag: "project:infra",       label: "Docker Compose" },
  { priority: 4,  filename: "docker-compose.yaml",  tag: "project:infra",       label: "Docker Compose" },
  { priority: 5,  filename: "CONTRIBUTING.md",      tag: "project:docs",        label: "Contributing guide" },
  { priority: 5,  filename: "CHANGELOG.md",         tag: "project:docs",        label: "Changelog" },
  { priority: 5,  filename: "LICENSE",              tag: "project:docs",        label: "License" },
];

// ─── Entry points (common patterns) ────────────────────────────────

const ENTRY_POINTS = [
  "src/index.ts", "src/index.js", "src/main.ts", "src/main.js",
  "index.ts", "index.js", "main.ts", "main.js",
  "src/app.ts", "src/app.js", "src/server.ts", "src/server.js",
  "lib/index.ts", "lib/index.js",
  "cli.ts", "cli.js", "bin/cli.ts", "bin/cli.js",
];

// ─── Configuration file patterns ────────────────────────────────────

const CONFIG_PATTERNS = [
  /^\.\w+rc$/i,           // .eslintrc, .prettierrc
  /^\.\w+rc\.\w+$/i,     // .eslintrc.json, .babelrc.js
  /^\w+\.config\.\w+$/i, // next.config.js, tailwind.config.ts
  /^vitest\.config\.\w+$/i,
  /^jest\.config\.\w+$/i,
  /^webpack\.config\.\w+$/i,
  /^vite\.config\.\w+$/i,
  /^rollup\.config\.\w+$/i,
];

// ─── Configurable depth ─────────────────────────────────────────────

/** Maximum directory depth for recursive structure walk. */
const MAX_STRUCTURE_DEPTH = 4;

/** Max files to list per directory (after that, show count only). */
const MAX_FILES_PER_DIR = 15;

/** Max total lines in the structure memory. */
const MAX_STRUCTURE_LINES = 80;

// ─── Source file harvesting limits ──────────────────────────────────

/** Source file extensions to harvest individually. */
const SOURCE_EXTS = new Set([
  // ── Web: JS/TS ─────────────────────────────────────────────────
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".vue", ".svelte", ".astro",
  ".coffee", ".litcoffee", ".ls",            // CoffeeScript, LiveScript
  ".moon",                                      // MoonScript

  // ── Web: Templates ────────────────────────────────────────────
  ".pug", ".jade", ".haml", ".slim",          // HTML preprocessors
  ".ejs", ".hbs", ".handlebars", ".mustache", // JS template engines
  ".njk", ".nunjucks", ".liquid",             // Jinja/Nunjucks/Liquid
  ".erb", ".slim",                              // Ruby templates
  ".ctp",                                       // CakePHP

  // ── Styles ────────────────────────────────────────────────────
  ".css", ".scss", ".sass", ".less", ".styl", ".stylus",
  ".postcss", ".sss",                          // PostCSS, SugarSS
  ".xsl", ".xslt",                              // XSLT

  // ── Markup ────────────────────────────────────────────────────
  ".html", ".htm", ".xhtml", ".xml", ".svg",
  ".xaml",                                      // XAML
  ".storyboard", ".xib",                       // iOS/macOS UI
  ".plist", ".entitlements",                   // macOS config

  // ── Documentation ─────────────────────────────────────────────
  ".md", ".mdx", ".markdown", ".mdown", ".mkdn", ".mkd", ".mdwn", ".mdtext",
  ".rst", ".adoc", ".asciidoc",               // reStructuredText, AsciiDoc
  ".tex", ".latex", ".ltx", ".bib",           // LaTeX
  ".org",                                       // Emacs org-mode
  ".wiki", ".txt", ".log",                     // Plain text
  ".ipynb",                                     // Jupyter notebooks (JSON)

  // ── Python ────────────────────────────────────────────────────
  ".py", ".pyi", ".pyx", ".pxd", ".pxi", ".pyw",
  ".gyp", ".gypi",                              // Python build

  // ── Rust ──────────────────────────────────────────────────────
  ".rs", ".rlib", ".rust",

  // ── Go ────────────────────────────────────────────────────────
  ".go",

  // ── Java / JVM ────────────────────────────────────────────────
  ".java", ".kt", ".kts",                       // Java, Kotlin + script
  ".groovy", ".gvy", ".gy", ".gsh",             // Groovy
  ".gradle", ".gradle.kts",                     // Gradle build
  ".scala", ".sc",                              // Scala
  ".clj", ".cljs", ".cljc", ".edn",            // Clojure + data
  ".jsh", ".jslib",                             // Jenkins

  // ── Swift / iOS ───────────────────────────────────────────────
  ".swift",

  // ── C / C++ ───────────────────────────────────────────────────
  ".c", ".cpp", ".cc", ".cxx", ".c++",        // C++ variants
  ".h", ".hpp", ".hh", ".hxx", ".h++",        // C/C++ headers
  ".ino",                                        // Arduino
  ".m", ".mm",                                    // Objective-C, Objective-C++

  // ── C# / .NET ─────────────────────────────────────────────────
  ".cs", ".csx",                                 // C#
  ".vb", ".vbx",                                 // VB.NET
  ".fs", ".fsx", ".fsi",                         // F#
  ".csproj", ".vbproj", ".fsproj",               // .NET project files (XML)

  // ── Ruby ──────────────────────────────────────────────────────
  ".rb", ".rbw",                                  // Ruby
  ".rake", ".gemspec", ".ru", ".jbuilder",

  // ── PHP ───────────────────────────────────────────────────────
  ".php", ".phtml", ".php3", ".php4", ".php5", ".php7", ".phps", ".phpt", ".pht",

  // ── Shell / Scripting ─────────────────────────────────────────
  ".sh", ".bash", ".zsh", ".fish", ".ksh", ".tcsh", ".csh",
  ".ps1", ".psm1", ".psd1", ".ps1xml",         // PowerShell
  ".awk", ".sed",
  ".nu",                                         // Nushell

  // ── Lua ───────────────────────────────────────────────────────
  ".lua", ".rockspec",

  // ── R ─────────────────────────────────────────────────────────
  ".r", ".R", ".rda", ".rds",

  // ── Julia ─────────────────────────────────────────────────────
  ".jl",

  // ── Elixir / Erlang ───────────────────────────────────────────
  ".ex", ".exs",                                  // Elixir
  ".erl", ".hrl",                                  // Erlang
  ".heex", ".leex",                               // Elixir templates

  // ── Haskell ───────────────────────────────────────────────────
  ".hs", ".lhs", ".hsc",
  ".cabal",                                       // Haskell package

  // ── OCaml ─────────────────────────────────────────────────────
  ".ml", ".mli", ".mll", ".mly",

  // ── Lisp / Scheme ─────────────────────────────────────────────
  ".lisp", ".lsp", ".cl",                       // Common Lisp
  ".el", ".elc",                                  // Emacs Lisp
  ".scm", ".ss", ".sch",                         // Scheme
  ".rkt",                                         // Racket
  ".clj", ".cljs", ".cljc",                      // already in Clojure

  // ── Reason / ReScript / OCaml ────────────────────────────
  ".re", ".rei",                                  // ReasonML
  ".res", ".resi",                                // ReScript

  // ── Dart / Flutter ────────────────────────────────────────────
  ".dart",

  // ── Zig ───────────────────────────────────────────────────────
  ".zig", ".zon",

  // ── Nim ───────────────────────────────────────────────────────
  ".nim", ".nims", ".nimble",

  // ── Crystal ───────────────────────────────────────────────────
  ".cr",

  // ── V ──────────────────────────────────────────────────────────
  ".v", ".vsh",

  // ── D ──────────────────────────────────────────────────────────
  ".d",

  // ── Perl ───────────────────────────────────────────────────────
  ".pl", ".pm", ".t", ".pod",

  // ── Tcl ────────────────────────────────────────────────────────
  ".tcl", ".tk",

  // ── Terraform / HCL ───────────────────────────────────────────
  ".tf", ".tfvars", ".tfstate", ".tfplan",
  ".hcl",                                         // HashiCorp config
  ".nomad", ".var",                               // Nomad
  ".pkr", ".pkr.hcl",                             // Packer

  // ── Protocol Buffers / IDL ────────────────────────────────────
  ".proto", ".thrift",
  ".capnp",                                       // Cap'n Proto
  ".fbs",                                         // FlatBuffers
  ".avsc",                                        // Avro schema

  // ── SQL / Databases ───────────────────────────────────────────
  ".sql", ".mysql", ".pgsql", ".psql",
  ".graphql", ".gql",
  ".prisma",                                      // Prisma schema
  ".dbml",                                        // DBML
  ".mermaid",                                     // Mermaid diagrams

  // ── Config / Data ─────────────────────────────────────────────
  ".json", ".json5", ".jsonc", ".jsonnet",       // JSON variants
  ".yaml", ".yml",
  ".toml",
  ".xml", ".xsl", ".xslt", ".xsd", ".dtd",       // already in Markup
  ".cfg", ".conf", ".ini", ".env", ".env.example",
  ".properties", ".props", ".prefs",             // Java properties
  ".editorconfig",
  ".gitignore", ".dockerignore", ".helmignore", ".slugignore",
  ".gitattributes", ".gitmodules",
  ".yarnrc", ".npmrc",
  ".babelrc", ".eslintrc",                        // will match CONFIG_PATTERNS too
  ".prettierrc",
  ".dhall",
  ".pkl",                                         // Apple/Generic config

  // ── Build / CI ────────────────────────────────────────────────
  ".bzl", ".BUILD",                               // Bazel/Starlark
  ".bazel", ".bazelrc",
  ".cmake", ".cmake.in",                           // CMake
  ".mk", ".mak", ".mkfile",                       // Make alternatives
  ".m4",                                          // m4 macro processor
  ".ninja",                                       // Ninja build
  ".gyp", ".gypi",                                // GYP (Chromium)

  // ── Assembly / Low-level ──────────────────────────────────────
  ".asm", ".s", ".inc", ".macro",
  ".ll",                                          // LLVM IR
  ".bc",                                          // LLVM bitcode

  // ── Patches / Diffs ───────────────────────────────────────────
  ".patch", ".diff",

  // ── Vala ──────────────────────────────────────────────────────
  ".vala", ".vapi",

  // ── Ada / SPARK ───────────────────────────────────────────────
  ".ada", ".adb", ".ads",

  // ── Forth ─────────────────────────────────────────────────────
  ".fth", ".4th", ".fs",                             // Forth (.fs conflicts with F#)

  // ── Fortran ───────────────────────────────────────────────────
  ".f", ".for", ".f90", ".f95", ".f03", ".f08",

  // ── COBOL ─────────────────────────────────────────────────────
  ".cbl", ".cob", ".cpy",

  // ── Puppet ────────────────────────────────────────────────────
  ".pp", ".epp",

  // ── Ansible ───────────────────────────────────────────────────
  ".ansible",                                       // unlikely but

  // ── Graphviz / DOT ────────────────────────────────────────────
  ".dot", ".gv",

  // ── PlantUML ──────────────────────────────────────────────────
  ".puml", ".pu", ".plantuml",

  // ── CSV / TSV / Data ──────────────────────────────────────────
  ".csv", ".tsv",

  // ── Hy (Lisp on Python) ──────────────────────────────────────
  ".hy",

  // ── Io ────────────────────────────────────────────────────────
  ".io",

  // ── Janet ─────────────────────────────────────────────────────
  ".janet",

  // ── Wren ──────────────────────────────────────────────────────
  ".wren",

  // ── PureScript ────────────────────────────────────────────────
  ".purs",

  // ── Gleam ─────────────────────────────────────────────────────
  ".gleam",

  // ── Roc ───────────────────────────────────────────────────────
  ".roc",

  // ── Mojo ──────────────────────────────────────────────────────
  ".mojo", ".🔥",
]);

/** Max file size (bytes) to harvest individually. */
const MAX_FILE_SIZE = 20_000;

/** Max total file memories to prevent bloat. */
const MAX_FILE_MEMORIES = 500;

// ─── Main Harvest Function ──────────────────────────────────────────

/**
 * Harvest project knowledge and store as memories.
 * Returns the number of new memories created.
 */
export async function harvestProject(projectDir: string): Promise<number> {
  // 1. Clear old project memories before re-harvesting
  await clearProjectMemories();

  let count = 0;

  // 2. Project overview (package.json / README)
  count += await harvestKeyFiles(projectDir);

  // 3. Directory structure overview (recursive, up to MAX_STRUCTURE_DEPTH)
  count += await harvestDirectoryStructure(projectDir);

  // 4. Entry points
  count += await harvestEntryPoints(projectDir);

  // 5. Configuration files
  count += await harvestConfigFiles(projectDir);

  // 6. All source files (individual file memories)
  count += await harvestAllSourceFiles(projectDir);

  return count;
}

// ─── Clear old project memories ────────────────────────────────────

async function clearProjectMemories(): Promise<void> {
  const entries = await store.list({ tags: ["project"] });
  for (const entry of entries) {
    // Only delete entries tagged with "project" (not manual/user memories)
    if (entry.tags.includes("project")) {
      await store.delete(entry.id);
    }
  }
}

// ─── Harvest Key Files ──────────────────────────────────────────────

async function harvestKeyFiles(projectDir: string): Promise<number> {
  let count = 0;

  for (const kf of KEY_FILES) {
    const filePath = path.join(projectDir, kf.filename);
    if (!fs.existsSync(filePath)) continue;

    try {
      const content = fs.readFileSync(filePath, "utf-8").slice(0, 3000); // limit size
      const lines = content.split("\n");
      const preview = lines.slice(0, 5).join("\n");

      let summary = kf.label;
      let tags = ["project", kf.tag, kf.filename.toLowerCase().replace(/\./g, ":")];

      // Special handling for package.json
      if (kf.filename === "package.json") {
        try {
          const pkg = JSON.parse(content);
          const deps = Object.keys(pkg.dependencies ?? {}).length;
          const devDeps = Object.keys(pkg.devDependencies ?? {}).length;
          const scripts = Object.keys(pkg.scripts ?? {}).length;
          summary = `Package: ${pkg.name ?? "unknown"} v${pkg.version ?? "?"} — ${deps} deps, ${devDeps} dev, ${scripts} scripts`;
          tags.push(`lang:${detectLanguage(pkg)}`);
        } catch { /* use default summary */ }
      }

      // Special handling for README
      if (kf.filename === "README.md") {
        // Extract first heading as title
        const titleMatch = content.match(/^#\s+(.+)/m);
        const title = titleMatch ? titleMatch[1].trim() : "README";
        summary = `README: ${title} (${lines.length} lines)`;
      }

      await store.store({
        content: `${kf.label}\n\n${content.slice(0, 2000)}`,
        summary,
        tags,
        source: "auto",
      });
      count++;
    } catch {
      // Skip unreadable files
    }
  }

  return count;
}

// ─── Harvest Directory Structure (recursive) ─────────────────────

interface WalkResult {
  lines: string[];
  totalFiles: number;
  totalDirs: number;
  truncated: boolean;
}

/** Recursively walk a directory and build an indented tree. */
function walkDirectory(dirPath: string, indent: string, depth: number): WalkResult {
  const result: WalkResult = { lines: [], totalFiles: 0, totalDirs: 0, truncated: false };
  if (depth <= 0) return result;

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    result.truncated = true;
    return result;
  }

  // Separate and sort: dirs first, then files, alphabetically
  const dirs = entries
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = entries
    .filter((e) => e.isFile() && !SKIP_FILES.has(e.name) && !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Track if we hit the line limit
  let linesBudget = MAX_STRUCTURE_LINES - result.lines.length;

  for (const dir of dirs) {
    if (result.lines.length >= MAX_STRUCTURE_LINES) {
      result.lines.push(`${indent}  ... (more directories)`);
      result.truncated = true;
      break;
    }
    result.totalDirs++;
    const subPath = path.join(dirPath, dir.name);
    const sub = walkDirectory(subPath, indent + "  ", depth - 1);
    result.totalFiles += sub.totalFiles;
    result.totalDirs += sub.totalDirs;
    const countInfo = sub.totalFiles > 0 ? ` (${sub.totalFiles} files)` : "";
    result.lines.push(`${indent}📁 ${dir.name}/${countInfo}`);
    result.lines.push(...sub.lines);
    if (sub.truncated && result.lines.length < MAX_STRUCTURE_LINES) {
      result.lines.push(`${indent}  ...`);
    }
  }

  for (const file of files) {
    if (result.lines.length >= MAX_STRUCTURE_LINES) {
      result.lines.push(`${indent}  ... (more files)`);
      result.truncated = true;
      break;
    }
    result.totalFiles++;
    result.lines.push(`${indent}📄 ${file.name}`);
  }

  return result;
}

async function harvestDirectoryStructure(projectDir: string): Promise<number> {
  // Get top-level first for a quick overview
  const topLevel: string[] = [];
  let topFiles = 0;
  let topDirs = 0;

  try {
    const entries = fs.readdirSync(projectDir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        topDirs++;
        topLevel.push(`📁 ${entry.name}/`);
      } else {
        topFiles++;
        topLevel.push(`📄 ${entry.name}`);
      }
    }
  } catch { /* permission error */ }

  // Full recursive tree (deeper)
  const tree = walkDirectory(projectDir, "", MAX_STRUCTURE_DEPTH);

  if (tree.lines.length === 0) return 0;

  const summary = `Project structure: ${tree.totalFiles} files, ${tree.totalDirs} directories`;
  const truncatedNote = tree.truncated ? "\n(Structure truncated — too large to show fully)" : "";
  const content =
    `Full project structure (${tree.totalFiles} files, ${tree.totalDirs} dirs):\n` +
    tree.lines.join("\n") +
    `\n\nTop-level summary: ${topFiles} files, ${topDirs} dirs` +
    truncatedNote;

  await store.store({
    content,
    summary,
    tags: ["project", "project:structure", "project:overview"],
    source: "auto",
  });

  return 1;
}

// ─── Harvest Entry Points (with subdirectory scan) ───────────────

async function harvestEntryPoints(projectDir: string): Promise<number> {
  let count = 0;

  // Check explicit paths first (fast path)
  const checked = new Set<string>();
  for (const ep of ENTRY_POINTS) {
    const filePath = path.join(projectDir, ep);
    if (checked.has(filePath)) continue;
    checked.add(filePath);
    if (!fs.existsSync(filePath)) continue;

    try {
      const content = fs.readFileSync(filePath, "utf-8").slice(0, 1500);
      const lines = content.split("\n");
      const imports = lines.filter((l) => /^import\s/.test(l)).slice(0, 10);
      const summary = `Entry point: ${ep} (${lines.length} lines, ${imports.length} imports)`;

      await store.store({
        content: `Entry point: ${ep}\n\n${content.slice(0, 1000)}`,
        summary,
        tags: ["project", "project:entry", `file:${ep.replace(/[/\\]/g, ":")}`],
        source: "auto",
      });
      count++;
    } catch { /* skip */ }
  }

  return count;
}

// ─── Harvest Config Files (recursive, up to 2 levels) ─────────────

async function harvestConfigFiles(projectDir: string): Promise<number> {
  let count = 0;

  const scanDir = async (dir: string, depth: number): Promise<void> => {
    if (depth <= 0) return;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch { continue; }

      if (stat.isDirectory()) {
        if (!SKIP_DIRS.has(entry) && !entry.startsWith(".")) {
          await scanDir(fullPath, depth - 1);
        }
        continue;
      }

      if (SKIP_FILES.has(entry) || KEY_FILES.some((kf) => kf.filename === entry)) continue;
      if (!CONFIG_PATTERNS.some((p) => p.test(entry))) continue;
      if (stat.size > 10000) continue;

      try {
        const content = fs.readFileSync(fullPath, "utf-8").slice(0, 1000);
        const lines = content.split("\n");
        const relPath = path.relative(projectDir, fullPath);

        await store.store({
          content: `Config: ${relPath}\n\n${content}`,
          summary: `Config: ${relPath} (${lines.length} lines)`,
          tags: ["project", "project:config", `file:${relPath.replace(/[/\\]/g, ":").replace(/\./g, ":")}`],
          source: "auto",
        });
        count++;
      } catch { /* skip */ }
    }
  };

  await scanDir(projectDir, 2);
  return count;
}

// ─── Harvest All Source Files (recursive) ────────────────────────

async function harvestAllSourceFiles(projectDir: string): Promise<number> {
  let count = 0;
  let skippedSize = 0;
  let skippedExt = 0;

  const walk = async (dir: string): Promise<void> => {
    if (count >= MAX_FILE_MEMORIES) return;

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }

    for (const e of entries) {
      if (count >= MAX_FILE_MEMORIES) break;
      if (SKIP_DIRS.has(e.name) || SKIP_FILES.has(e.name)) continue;
      if (e.name.startsWith(".")) continue;

      const fullPath = path.join(dir, e.name);

      if (e.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!e.isFile()) continue;

      const ext = path.extname(e.name).toLowerCase();
      if (!SOURCE_EXTS.has(ext)) {
        skippedExt++;
        continue;
      }

      let stat: fs.Stats;
      try { stat = fs.statSync(fullPath); } catch { continue; }

      if (stat.size > MAX_FILE_SIZE) {
        skippedSize++;
        continue;
      }

      if (stat.size === 0) continue; // skip empty files

      try {
        const content = fs.readFileSync(fullPath, "utf-8").slice(0, 1000);
        const lines = content.split("\n");
        const relPath = path.relative(projectDir, fullPath);

        // Build a useful summary
        let summary = relPath;
        if (ext === ".json") {
          // JSON files: show top-level keys
          try {
            const parsed = JSON.parse(content);
            const keys = Object.keys(parsed).slice(0, 8);
            summary = `${relPath} — {${keys.join(", ")}${Object.keys(parsed).length > 8 ? "..." : ""}}`;
          } catch { summary = `${relPath} (${lines.length} lines)`; }
        } else if (ext === ".md") {
          // Markdown: show first heading
          const titleMatch = content.match(/^#\s+(.+)/m);
          const title = titleMatch ? titleMatch[1].trim() : path.basename(relPath);
          summary = `${relPath} — ${title} (${lines.length} lines)`;
        } else {
          // Code: show line count + first import/export
          const firstSig = lines.find(l => /^(import|export|function|class|const|let|var|def|pub|fn)\s/.test(l));
          const sig = firstSig ? firstSig.slice(0, 60) : "";
          summary = `${relPath} (${lines.length} lines${sig ? `, e.g. ${sig}...` : ""})`;
        }

        // First 100 files get full preview, rest get shorter preview
        const previewLen = count < 100 ? 1000 : 300;

        await store.store({
          content: `File: ${relPath}\n\n${content.slice(0, previewLen)}`,
          summary,
          tags: ["project", "project:file", `file:${relPath.replace(/[/\\]/g, ":").replace(/\./g, ":")}`],
          source: "auto",
        });
        count++;
      } catch { /* skip unreadable */ }
    }
  };

  await walk(projectDir);

  return count;
}

function detectLanguage(pkg: Record<string, unknown>): string {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } as Record<string, string>;
  const allDeps = Object.keys(deps).join(" ");

  if (/\breact\b|\bnext\b|\bvue\b|\banguler\b|\bsvelte\b/i.test(allDeps)) return "typescript";
  if (/\bexpress\b|\bkoa\b|\bfastify\b|\bnest\b/i.test(allDeps)) return "typescript";
  if (/\bjest\b|\bvitest\b|\beslint\b|\bprettier\b/i.test(allDeps)) return "typescript";
  if (/\bpython\b|\bdjango\b|\bflask\b|\bfastapi\b/i.test(allDeps)) return "python";
  if (/\brust\b|\bcargo\b/i.test(allDeps)) return "rust";
  if (/\bgo\b|\bgolang\b/i.test(allDeps)) return "go";

  return "unknown";
}
