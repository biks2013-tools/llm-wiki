# llm-wiki

A TypeScript implementation of Andrej Karpathy's **LLM Wiki** pattern — the idea file he published as a gist in April 2026 ([karpathy/442a6bf555914893e9891c11519de94f](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)). Instead of RAG that re-derives answers from raw documents on every question, an LLM **incrementally compiles** your sources into a persistent, interlinked wiki — markdown pages, or standalone HTML pages you read in a browser — that keeps getting richer. This tool gives you the three layers, the two special files, the operations, and the "optional CLI tools" the gist describes, aimed at indexing and searching personal documentation.

## User guide (slides)

A 30-slide walkthrough of setup, the daily loop, documents (PDF, Word, PowerPoint, Excel, images), agent integration, and several wikis in markdown or HTML, in the BikS2013 theme:

- **[View the deck](https://biks2013-tools.github.io/llm-wiki/presentations/llm-wiki-user-guide.html)** (HTML, arrow keys to navigate; double-click text to edit, right-click for the menu)
- [PDF](https://biks2013-tools.github.io/llm-wiki/presentations/llm-wiki-user-guide.pdf) · [PowerPoint](https://github.com/biks2013-tools/llm-wiki/raw/main/docs/presentations/llm-wiki-user-guide.pptx)

## What it implements from the spec

| Spec element | Implementation |
|---|---|
| Raw sources (immutable) | `raw/` — the tool only ever reads it; external files are copied in on ingest |
| The wiki (LLM-owned markdown) | `wiki/` with `sources/`, `entities/`, `concepts/`, `syntheses/`, `lint/`, optional `overview.md` |
| The schema | `CLAUDE.md` + `AGENTS.md` written into the wiki root from `templates/CLAUDE.md` |
| `index.md` (content catalog) | Generated deterministically from page frontmatter by `llm-wiki index` |
| `log.md` (chronological, grep-able) | Append-only `## [YYYY-MM-DD] kind \| title` entries; `llm-wiki log --last 5` |
| Ingest | `llm-wiki ingest raw/file.md` — LLM writes the summary page and updates 5–15 entity/concept pages, then index + log + ledger are updated |
| Query | `llm-wiki query "…"` — search → read pages → cited answer; `--file` files it as a synthesis page |
| Lint | `llm-wiki lint` (dangling links, orphans, stale index, un-ingested sources) and `--llm` (contradictions, stale claims, missing pages/links, gaps, next questions) |
| Search tool (CLI + MCP) | Local BM25, vector, and hybrid (RRF) search over heading-level chunks; `llm-wiki mcp` exposes `wiki_search`, `wiki_read_page`, `wiki_write_page`, … |
| PDF / DOCX sources | A dedicated parser LLM converts originals to `raw/<doc>.pdf.md` / `raw/<doc>.docx.md`; the original stays untouched in `raw/` and is referenced from the conversion and the wiki's source page |

## Install

```bash
pnpm install
pnpm link:global    # builds, then installs the `llm-wiki` command on your PATH
llm-wiki --version
```

Requires Node 22+ and pnpm's global bin folder on your PATH (`pnpm setup` adds it). The command is a link to this checkout, so after pulling changes run `pnpm build` and the global command picks them up. Remove it with `pnpm unlink:global`.

## Claude skill

`skills/llm-wiki/SKILL.md` is a ready-made Claude Code skill that lets Claude operate the tool: it picks the right wiki, always passes `--wiki` and `--json`, flags LLM costs, and follows the guardrails (never touching `raw/`, the index or the log). Install it once:

```bash
pnpm skill:install     # symlinks ~/.claude/skills/llm-wiki to this repo; pnpm skill:uninstall removes it
```

Then ask Claude things like "add this PDF to my work wiki" or "what do my wikis say about Kubernetes?". Development notes: `llm-wiki-docs/`.

## Full guide (for people and AI agents)

`llm-wiki guide` prints a complete manual: concepts, wiki layout, how a wiki is chosen, every command and option (generated from the CLI itself), task recipes, configuration, the JSON shape of every `--json` output, exit codes, the MCP tools, rules for agents, and instructions for building a Claude skill on top of the tool.

```bash
llm-wiki guide              # everything, as markdown
llm-wiki guide --topics     # overview, layout, selection, commands, workflows, config, output, errors, mcp, agent-rules, skill
llm-wiki guide workflows    # one topic
llm-wiki guide --json       # machine-readable: topics plus the full command/option tree
```

To have Claude write a skill for the tool, ask it to run `llm-wiki guide` (or `llm-wiki guide skill` first) and build the skill from the output.

## Configure

Settings resolve in four tiers, lowest to highest priority: shell env → `~/.tool-agents/llm-wiki/.env` → `./.env` → CLI flags. Missing settings raise an error; nothing is defaulted.

```bash
# ~/.tool-agents/llm-wiki/.env
LLM_WIKI_PROVIDER=anthropic          # openai | anthropic | gemini | azure-openai | azure-anthropic | ollama | litellm | mlx
LLM_WIKI_MODEL=claude-opus-5
ANTHROPIC_API_KEY=...

# optional — enables vector / hybrid search
LLM_WIKI_EMBEDDING_PROVIDER=openai
LLM_WIKI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_API_KEY=...

# optional — dedicated model for converting PDF / DOCX originals to markdown
LLM_WIKI_PARSER_PROVIDER=gemini      # anthropic, gemini, openai, azure-openai, litellm read PDFs natively; ollama/mlx get locally extracted text
LLM_WIKI_PARSER_MODEL=gemini-3.6-pro
```

Provider credentials use the vendor's canonical names: `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_ORG_ID`, `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`, `GOOGLE_API_KEY` (or `GEMINI_API_KEY`), `AZURE_OPENAI_API_KEY`/`AZURE_OPENAI_ENDPOINT`/`AZURE_OPENAI_DEPLOYMENT`/`AZURE_OPENAI_API_VERSION`, `AZURE_AI_INFERENCE_KEY`/`AZURE_AI_INFERENCE_ENDPOINT`, `OLLAMA_HOST`, `LITELLM_PROXY_URL`/`LITELLM_MASTER_KEY`; MLX-LM reuses `OPENAI_BASE_URL`. `llm-wiki config` shows what resolved and from where.

## Use

```bash
llm-wiki init ~/notes-wiki --format markdown --name notes   # creates raw/, wiki/, CLAUDE.md, index.md, log.md and registers it

cp ~/Downloads/some-article.md ~/notes-wiki/raw/
llm-wiki ingest raw/some-article.md        # or just `llm-wiki ingest` for every pending source
llm-wiki ingest raw/x.md --dry-run         # see the proposed page changes first

llm-wiki ingest raw/report.pdf             # converts with the parser LLM to raw/report.pdf.md, then ingests it
llm-wiki parse raw/contract.docx           # convert only, review raw/contract.docx.md before ingesting

llm-wiki search "postgres docker"          # BM25, no LLM needed
llm-wiki index --embed                     # compute embeddings, then:
llm-wiki search "how do I run the db" --mode hybrid

llm-wiki query "What did I decide about the deployment pipeline?" --file
llm-wiki lint --llm --report
llm-wiki log --last 5
```

Open the wiki root in Obsidian to browse it (graph view shows hubs and orphans), exactly as the gist suggests.

### Several wikis

Every wiki you `init` is registered by name in `~/.tool-agents/llm-wiki/wikis.json`. The first one becomes the current wiki; you choose the target of each command with `--wiki`, or change the default with `wikis use`.

```bash
llm-wiki init ~/work-wiki --format html --name work --description "Work documentation"
llm-wiki wikis add old ~/old-wiki          # register a wiki created earlier
llm-wiki wikis                             # list: name, root, pages, pending sources, last activity
llm-wiki wikis use work                    # default for commands that name no wiki
llm-wiki --wiki notes ingest raw/recipe.md # update one wiki explicitly
llm-wiki --wiki work query "Who owns the billing service?"
llm-wiki --pick query "..."                # choose from a list on the terminal
llm-wiki query "..." --wikis work,notes     # answer from several wikis; citations read [[work:page]]
llm-wiki search "kubernetes" --all-wikis   # or --wikis work,notes; hits are labelled by wiki
llm-wiki wikis current                     # which wiki will be used, and why
llm-wiki wikis remove old                  # unregister; files stay on disk
```

Selection order: `--wiki`/`LLM_WIKI_NAME` or `--root`/`LLM_WIKI_ROOT` first, then the current selection, then an interactive prompt on a terminal. Without any of these the command fails and lists the registered wikis.

### With Claude Code / Codex

The wiki root's `CLAUDE.md` is the schema: open the root in Claude Code and it becomes the wiki maintainer. Give it the search tool natively:

```bash
claude mcp add llm-wiki -- llm-wiki mcp
```

One server serves every registered wiki. Each tool takes an optional `wiki` argument, `wiki_list_wikis` lets the agent pick the right one, and `wiki_search` accepts `wikis: ["*"]` to search them all. Calls without a `wiki` use the current selection (or the wiki given by `--wiki`/`--root` when the server was added).

Tools exposed: `wiki_list_wikis`, `wiki_search`, `wiki_read_page`, `wiki_list_pages`, `wiki_write_page`, `wiki_append_log`, `wiki_recent_log`, `wiki_lint`, `wiki_reindex`.

## Documents, presentations, spreadsheets and images

Besides text sources (`.md .txt .csv .json .html .rst .org`), `raw/` accepts originals that are converted to markdown first and then ingested; the original is never modified:

| Original | Converted by |
|---|---|
| `.pdf`, `.docx` | the parser LLM (below) |
| `.pptx` | slides read locally (titles, text in reading order, tables, chart data, alt text, speaker notes) and sent with the slide pictures to the parser LLM, which writes one section per slide and transcribes the pictures |
| `.xlsx` | locally, **no LLM**: one markdown table per sheet with the exact stored values |
| `.png` `.jpg` `.jpeg` `.gif` `.webp` | the parser LLM with vision: text transcribed, charts as tables, diagrams and photos described |

`ingest` (or `parse`) sends a PDF/DOCX to the parser LLM configured by `LLM_WIKI_PARSER_PROVIDER` / `LLM_WIKI_PARSER_MODEL`, separate from the chat model, and writes the faithful markdown conversion next to the original as `raw/<name>.pdf.md` or `raw/<name>.docx.md`. Providers with native document input (Anthropic, Azure Anthropic/Foundry, Gemini, OpenAI, Azure OpenAI, LiteLLM) receive the PDF itself, which also handles scanned pages; Ollama and MLX receive text extracted locally with pdf.js. DOCX is always converted to HTML locally with mammoth first, then turned into markdown by the model.

The conversion's frontmatter records provenance and the body opens with a link to the original:

```markdown
---
title: Quarterly Report
original: raw/report.pdf
original_type: PDF
original_sha256: 3f2a…
parsed_by: gemini/gemini-3.6-pro
parsed_at: 2026-09-12
---
> **Converted from the original PDF document [[raw/report.pdf]]** (412 KB, sha256 3f2a…) by gemini/gemini-3.6-pro on 2026-09-12. The original is kept unmodified in `raw/`.
```

The wiki's `sources/` page also carries `original: raw/report.pdf` and links it. Conversions are cached by the original's hash in `.llm-wiki/parsed.json`; `--reparse` (or `parse --force`) redoes them.

## Page formats: markdown or HTML

Each wiki picks its page format once, at `init` (`--format markdown` or `--format html`, or `LLM_WIKI_FORMAT`); there is no default (`.llm-wiki/wiki.json` records it). A markdown wiki can be converted later with `llm-wiki --wiki <name> convert --to html` — no LLM involved, links rewritten, the markdown kept in `.llm-wiki/backup/`, and a customised `CLAUDE.md` merged so your own sections survive.

- **markdown** — `wiki/<id>.md` with YAML frontmatter and `[[wikilinks]]`. Best for Obsidian, editors and agents that read files.
- **html** — `wiki/<id>.html`, standalone pages you open in a browser (`open wiki/index.html`): relative links between pages and to `raw/` originals, a shared `wiki/wiki.css`, Index/Log navigation, metadata in a JSON block in `<head>`, and a Content-Security-Policy that disables scripts.

Ingest, query, search, lint and MCP work the same in both. The LLM writes every page as frontmatter + body; in an HTML wiki the body is an HTML fragment (or markdown), and the tool turns `[[wikilinks]]` into relative links, strips active content, and builds the page. `llm-wiki guide layout` has the details.

A markdown page:

```markdown
---
title: Ada Lovelace
type: entity            # overview | entity | concept | source | synthesis | lint
summary: One sentence shown in index.md.
tags: [mathematics]
created: 2026-04-02
updated: 2026-04-09
sources: [raw/some-article.md]
---
# Ada Lovelace

Links use wikilinks: [[analytical-engine]] or [[concepts/analytical-engine|the Engine]].
```

## Web pages

Pages that build their content with JavaScript are detected and printed to PDF in a headless browser (`LLM_WIKI_BROWSER`), then converted by the parser model; `--render` does that for any page. `llm-wiki --wiki <name> sources check` compares every downloaded page and every file ingested from outside the wiki with its stored copy by SHA-256 (web pages by their text, after a conditional request), and `sources update` re-ingests the changed ones as new dated originals.

`llm-wiki --wiki <name> ingest https://…` downloads a page (or an online PDF, Office file or image) into `raw/web/`, keeps that copy unmodified, converts a web page's main content to markdown locally (URL in the frontmatter), and ingests it. `parse <url>` stops after the conversion.

## Wiki Explorer (desktop app)

[`wiki-explorer`](../wiki-explorer) is a SwiftUI macOS app built on this CLI: browse the registered wikis and their pages, follow links and backlinks, search one or all wikis, ask questions with clickable source citations, add files or URLs, and create wikis. It uses `pages --json`, `show --json` (pages rendered to HTML with `llmwiki://` links), `graph --json` (its interactive graph view) and the citations in `query --json`.

## Develop

```bash
pnpm dev -- search "term" --root ./example
pnpm test
pnpm typecheck
```
