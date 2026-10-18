---
name: llm-wiki
description: This skill should be used when the user wants to work with their llm-wiki wikis (Karpathy-style LLM wikis, markdown or HTML) — "add/ingest this file into my wiki", "what does my wiki say about…", "ask all my wikis", "search my notes", "save this answer to the wiki", "convert this PDF to markdown", "which wikis do I have", "create/register a wiki", "make the wiki HTML/browsable", "lint the wiki", or mentions llm-wiki.
---

# llm-wiki

`llm-wiki` keeps **wikis** in Andrej Karpathy's LLM Wiki pattern: immutable sources in `raw/`, an
LLM-compiled, interlinked knowledge base in `wiki/` (markdown pages, or standalone HTML pages for the
browser — chosen per wiki), a generated index and an append-only log. Several wikis are kept in a named
registry. This skill tells you how to drive the CLI safely. The CLI documents itself: when anything here is
unclear or seems out of date, run `llm-wiki guide <topic>` (topics: `llm-wiki guide --topics`) — it is
generated from the installed version and wins over this file.

## 1. Preconditions

```bash
llm-wiki --version          # must exist; if missing, tell the user (installed with `pnpm link:global` in the llm-wiki repo) — do not install it yourself
llm-wiki config             # which settings resolved, from which tier; secrets are masked
```
- `ingest`, `query`, `lint --llm` need `LLM_WIKI_PROVIDER` + `LLM_WIKI_MODEL`.
- `ingest`/`parse` of PDF/DOCX/PPTX/images also need `LLM_WIKI_PARSER_PROVIDER` + `LLM_WIKI_PARSER_MODEL`
  (a model with vision for images and slide pictures). XLSX is converted locally and needs no parser.
- `search --mode vector|hybrid` and `index --embed` need `LLM_WIKI_EMBEDDING_PROVIDER` + `LLM_WIKI_EMBEDDING_MODEL`.
- `search` (bm25), `wikis`, `index` (without `--embed`), `lint` (without `--llm`), `log`, `convert` need no model.

A missing setting is exit code 2 with the setting's name: **report it to the user; never write a guessed
value into any `.env` file and never print API keys.**

## 2. Choose the wiki — every time

1. `llm-wiki wikis list --json` → each entry has `name`, `root`, `description`, `format` (`markdown`/`html`),
   `pages`, `pending`, `lastActivity`, `current`, `healthy`. Entries with `healthy: false` carry a `problem`
   instead of counts — skip them and mention the problem.
2. Match the user's request against `name` and `description`. If two wikis fit equally well, **ask**.
   If the right wiki is unclear and the task is a lookup, search them all first (§3, "search all").
3. Pass `--wiki <name>` on **every** wiki-bound command. Never rely on the current selection (the user
   may change it) and never use `--pick` (it needs a terminal).
4. Each wiki-bound command echoes `wiki: <name> — <root>` on stderr — check it. Most JSON outputs also carry a
   `wiki` field (not `lint`/`log`; a multi-wiki `query` has `wikis`).

## 3. Recipes (always `--json`, parse stdout only; stderr is progress)

| User intent | Command | LLM cost |
|---|---|---|
| add/ingest file(s) into wiki X | `llm-wiki --wiki X ingest <file>... --json` | yes |
| add a web page / online document | `llm-wiki --wiki X ingest <https-url> --json` (downloaded into `raw/web/`) | yes |
| check web pages / outside files for changes | `llm-wiki --wiki X sources check --json`; re-ingest changed ones with `sources update --json` (costs LLM calls; ask first) | check: no |
| list a wiki's pages / read one page | `llm-wiki --wiki X pages --json` / `llm-wiki --wiki X show <id> --json` | no |
| how the pages connect: hubs, unlinked pages, broken links | `llm-wiki --wiki X graph` (`--json` for nodes, links, sources, missing) | no |
| preview what an ingest would change | `llm-wiki --wiki X ingest <file> --dry-run --json` | yes |
| ingest everything pending in `raw/` | `llm-wiki --wiki X ingest --json` | yes |
| convert a PDF/DOCX/PPTX/XLSX/image to markdown only, to review first | `llm-wiki --wiki X parse <file> --json`, read `raw/<file>.<ext>.md`, then `ingest raw/<file>.<ext>.md --json` | yes |
| what does wiki X say about … | `llm-wiki --wiki X query "<q>" --json` | yes |
| question spanning several wikis | `llm-wiki query "<q>" --wikis X,Y --json` (or `--all-wikis`) | yes |
| answer and keep it in wiki X | `llm-wiki --wiki X query "<q>" --file --json` (filing re-asks the question: if the user may want to keep the answer, ask before the first query) | yes |
| find / where are notes on … (wiki known) | `llm-wiki --wiki X search "<terms>" --json` | no |
| search all wikis / some wikis | `llm-wiki search "<terms>" --all-wikis --json` / `--wikis X,Y` | no |
| include raw sources in a search | `llm-wiki --wiki X search "<terms>" --layer all --json` | no |
| enable semantic search | `llm-wiki --wiki X index --embed --json`, then `search "<q>" --mode hybrid --json` (`query` switches to hybrid by itself once embeddings exist) | embeddings |
| which wikis exist / details of one / which is current | `llm-wiki wikis list --json` / `wikis show X --json` / `wikis current` | no |
| create a wiki | `llm-wiki init <dir> --format markdown\|html --name <n> --description "<d>"` (ask the user for the directory) | no |
| register an existing wiki directory (already initialised) | `llm-wiki wikis add <name> <dir> --description "<d>"` | no |
| make X the default | `llm-wiki wikis use X` | no |
| make wiki X browsable (markdown → HTML) | see "Converting" below | no |
| check / clean up | `llm-wiki --wiki X lint --json` (`--fix` regenerates index; `--llm` semantic) | `--llm` only |
| recent activity | `llm-wiki --wiki X log --last 10 --json` (`--kind ingest\|query\|lint\|edit\|note`) | no |
| refresh index | `llm-wiki --wiki X index --json` | no (`--embed`: embeddings) |

Notes:
- **Search before you query.** `search` is local and free. Use it for "find / where is"; use `query`
  when the user wants a synthesised answer.
- Sources: text (`.md .txt .csv .json .html .rst .org`) and originals converted first — `.pdf .docx .pptx
  .xlsx` and images `.png .jpg .jpeg .gif .webp`. Legacy `.doc/.ppt/.xls` and `.heic/.tif` are refused.
- Files outside `raw/` given to `ingest`/`parse` are copied into `raw/` first. PDF/DOCX are converted to
  `raw/<file>.<ext>.md` (`x.pdf.md`, `x.docx.md`) by the parser model; the original is never modified.
- `lint` exits 1 when it finds errors, but stdout still holds the full JSON report — parse it and report
  the findings; it is not a failed command.
- For large or many sources, run `--dry-run` first and show the proposed pages when approval matters.
- `init` needs `--format`; if the user did not say, **ask**: `html` to read in a browser, `markdown` for
  editors/Obsidian/agents. A markdown wiki can be converted to HTML later; not the other way round.
- `query --file` works on one wiki only; a cross-wiki answer cannot be filed.

**Converting (markdown → HTML), only when the user asks:** check `format` is `markdown` (HTML wikis cannot
be converted back), run `llm-wiki --wiki X convert --to html --dry-run --json` and report `pages`,
`unresolvedLinks` and `schema` (`rewritten` = stock schema replaced, `merged` = template sections replaced and
custom sections kept, `kept` with `--keep-schema`). After the user agrees, run it without `--dry-run`; the
markdown is kept in `backup` (the only way back). If the wiki uses embeddings, run `index --embed` afterwards.

## 4. Reading results

- Page paths are root-relative (`wiki/entities/x.md` or `wiki/entities/x.html`); to read one, join it to
  the wiki's `root` from `wikis list --json`. Cross-wiki `search` hits carry a separate `wiki` field (read
  `<root of hit.wiki>/<hit.file>`); cross-wiki `query` → `pagesUsed` entries are `<wiki>:<path>`.
- `query --json` → `{wiki, question, answer, pagesUsed, filedAs}`; with several usable wikis
  `{wikis, question, answer, pagesUsed}` and citations `[[wiki:page-id]]`. With `--wikis` naming only one
  usable wiki the single-wiki shape comes back — tell them apart by `wiki` vs `wikis`.
- `search --json` → `[{wiki, file, layer, title, heading, score, snippet}]`.
- `ingest --json` → `{wiki, dryRun, results:[{source, original, skipped, title, takeaways, changes:[{op, page, reason}]}]}`.
- Full shapes: `llm-wiki guide output`.

When you relay an answer, keep its citations and say which wiki(s) it came from.

## 5. Errors

| Exit | Meaning | Do |
|---|---|---|
| 0 | ok | — |
| 1 | operational (bad input, missing file, wiki not initialised, refused oversize source, lint found errors, `wikis current` with nothing selected) | read stderr, fix the input (lint: report the JSON) |
| 2 | configuration (missing setting, unknown wiki, no wiki selected) | tell the user which setting/wiki; pass `--wiki` |
| 3 | LLM provider (auth, quota, model) | report; suggest `llm-wiki config`; retry later on rate limits |

Common messages:

| Message starts with | Do |
|---|---|
| `No wiki selected.` / `No wiki named "x"` | pass `--wiki` with a name from `wikis list` |
| `Missing required configuration setting X` | tell the user to set X; never invent it |
| `... is not an initialised wiki` | wrong directory; `init` only if the user wants a new wiki |
| `Pass either --root or --wiki, not both.` | keep one |
| `--pick needs an interactive terminal` | use `--wiki <name>` |
| `No embeddings are stored yet.` | `index --embed`, or `--mode bm25` |
| `... is not a supported source` | the message names the fix (e.g. save .ppt as .pptx, convert .heic to JPEG); tell the user |
| `... cannot read images` | the parser model has no vision; tell the user to configure one |
| `... above the --max-source-chars limit` | suggest splitting the source; raise the limit only if the user agrees |

More: `llm-wiki guide errors`.

## 6. Guardrails

- Never edit, move or delete anything under `raw/`; add sources only through `ingest`/`parse`.
- Never hand-edit the index (`wiki/index.md` / `wiki/index.html`), the log (`wiki/log.md` / `wiki/log.html`;
  append with MCP `wiki_append_log` instead) or anything in `.llm-wiki/`.
- If the user asks for a hand edit of a page: check the wiki's `format`; keep the frontmatter (markdown)
  or the `llm-wiki-meta` JSON block and `<main>` (HTML); then run `llm-wiki --wiki X index`. Prefer the MCP
  `wiki_write_page` tool, which builds HTML pages for you.
- Do not `init`, `convert`, or `wikis add|rename|remove|use|unset` unless the user asked; never `init --force`
  (it rewrites CLAUDE.md/AGENTS.md) unasked.
- Do not raise `--max-source-chars` / `--max-bytes`, or use `ingest --force` / `--reparse`, without the user
  agreeing.
- LLM commands cost time and money — do not loop them; say before running a large ingest.

## 7. MCP alternative

If the `llm-wiki` MCP server is connected (`claude mcp add llm-wiki -- llm-wiki mcp`), prefer its tools
for listing, searching, reading and writing pages (`wiki_list_wikis`, `wiki_search`, `wiki_read_page`,
`wiki_list_pages`, `wiki_write_page`, `wiki_append_log`, `wiki_recent_log`, `wiki_lint`, `wiki_reindex`).
The `wiki` argument is optional and falls back to the server default — always pass it. `wiki_search` also
takes `wikis` (`["*"]` = all). Use the CLI for `ingest`, `query`, `parse`, `convert` and `lint --llm`.
See `llm-wiki guide mcp`.
