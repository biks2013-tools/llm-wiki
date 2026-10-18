# Workflows (recipes)

All examples name the wiki explicitly with `--wiki`, which is what an agent should do.

## 1. Create a new wiki

```bash
llm-wiki init ~/wikis/research --format markdown --name research --description "Papers and notes on ML research"
llm-wiki init ~/wikis/handbook --format html --name handbook --description "Team handbook, read in a browser"
```
`--format` (or `LLM_WIKI_FORMAT`) is required: `markdown` for
editor/Obsidian/agent use, `html` for a wiki people open in a browser (`open ~/wikis/handbook/wiki/index.html`).
Everything else — ingest, query, search, lint, MCP — works the same in both. A markdown wiki can be
converted to HTML later (recipe 11); there is no way back except restoring the backup.
The first registered wiki becomes current automatically; `--use` makes this one current.
`--no-register` creates the directory without registering it.

## 2. Add documents to a wiki (update it)

```bash
# a markdown/text file anywhere on disk: copied into raw/, then compiled into pages
llm-wiki --wiki research ingest ~/Downloads/attention.md

# preview first: shows the pages the model would create/replace/append, writes nothing
llm-wiki --wiki research ingest ~/Downloads/attention.md --dry-run --json

# PDF / DOCX: converted by the parser model to raw/<name>.pdf.md, then compiled
llm-wiki --wiki research ingest ~/Downloads/paper.pdf

# a web page or an online document: downloaded into raw/web/ and kept, then compiled
llm-wiki --wiki research ingest https://example.com/blog/attention-explained

# several files, or every source in raw/ not ingested yet
llm-wiki --wiki research ingest a.md b.pdf c.docx
llm-wiki --wiki research ingest
```
A URL is downloaded into `raw/web/<host>-<path>.<ext>` and that copy is kept unmodified. A web page is also
converted locally (no LLM) to `raw/web/<name>.html.md` — its main content (`<article>`/`<main>`), without
navigation, scripts and footers, with the URL in the frontmatter — and that conversion is ingested; a PDF,
Office file or image is converted like a local one. Downloading the same URL again reuses an identical copy;
a changed page is kept as a new, dated original. A web page whose content is built by JavaScript (an almost
empty application shell, a "please enable JavaScript" notice) is opened in a headless browser and printed to
PDF — the PDF is kept as the original and converted by the parser model. This needs `LLM_WIKI_BROWSER`
(Chrome, Chromium, Edge or Brave executable); `--render` prints any page that way. `parse <url>` downloads and
converts without ingesting.
Unchanged sources are skipped (tracked by hash); `--force` re-ingests. Sources larger than
`--max-source-chars` are refused, never truncated. After ingest, the index, the search index and
the log are already updated.

## 3. Convert a document or image without ingesting (to review it first)

```bash
llm-wiki --wiki research parse ~/Downloads/contract.docx --json
llm-wiki --wiki research parse ~/Downloads/q3-review.pptx ~/Downloads/whiteboard.jpg --json
llm-wiki --wiki research parse ~/Downloads/budget.xlsx --json      # local, no model needed
# read raw/<file>.<ext>.md, then:
llm-wiki --wiki research ingest raw/contract.docx.md
```
Accepted: `.pdf .docx .pptx .xlsx .png .jpg .jpeg .gif .webp` (see the `layout` topic for how each is
converted). `ingest` of the original does the conversion and the ingest in one step.

## 4. Answer a question from a wiki

```bash
llm-wiki --wiki research query "How does multi-head attention differ from RNN gating?" --json
# keep a valuable answer as a synthesis page in the wiki:
llm-wiki --wiki research query "Compare the three tokenizers" --file --json
```
The answer cites wiki pages; `pagesUsed` lists them. If the wiki has nothing relevant the answer says so.

When the question spans subjects kept in different wikis, answer from several at once:
```bash
llm-wiki query "Which vendors appear both in the committee decks and in my research notes?" --wikis ai-committee,research --json
llm-wiki query "What do my wikis say about Kubernetes?" --all-wikis --json
```
Each wiki is searched on its own index, the rankings are fused, and the best pages from all wikis share the
`--pages` / `--context-chars` budget. Citations name the wiki: `[[ai-committee:entities/sofia]]`. Each wiki
consulted gets a `query` log entry. `--file` is refused with several wikis — a cross-wiki answer has no single
home; re-ask with `--wiki <name> --file` to keep it in one wiki. Markdown and HTML wikis can be mixed.

## 5. Find information without an LLM

```bash
llm-wiki --wiki research search "positional encoding" --json            # BM25, free and instant
llm-wiki --wiki research search "positional encoding" --layer all --json  # include raw/ sources
llm-wiki search "kubernetes upgrade" --all-wikis --json                   # every registered wiki
llm-wiki search "budget" --wikis work,personal --json                     # a chosen set
```
Read a hit's file directly from `<root>/<file>` (root from `wikis show <name> --json`).

## 6. Semantic search (embeddings)

```bash
llm-wiki --wiki research index --embed     # compute missing embeddings once (and after ingests)
llm-wiki --wiki research search "how do models remember order" --mode hybrid --json
```
Requires `LLM_WIKI_EMBEDDING_PROVIDER` and `LLM_WIKI_EMBEDDING_MODEL`. `query` uses hybrid automatically
when embeddings exist.

## 7. Maintain a wiki

```bash
llm-wiki --wiki research lint --json                 # structural, free; exit 1 if errors found
llm-wiki --wiki research lint --fix                  # regenerate the index and search index
llm-wiki --wiki research lint --llm --report         # + contradictions, stale claims, gaps; filed in wiki/lint/
llm-wiki --wiki research index                       # after editing pages by hand
llm-wiki --wiki research log --last 10 --json
```

## 8. Which wiki should this go to?

```bash
llm-wiki wikis list --json      # choose by name/description; ask the user when ambiguous
```

## 9. Register a wiki that already exists on disk

```bash
llm-wiki wikis add archive ~/old-notes-wiki --description "Old notes"
```
The directory must already be an initialised wiki (has `raw/`, `wiki/`, `.llm-wiki/`).

## 10. Check the setup

```bash
llm-wiki config        # which settings resolved from which tier, registry path, selected wiki
llm-wiki wikis current
```

## 11. Convert a markdown wiki to HTML

```bash
llm-wiki --wiki notes convert --to html --dry-run --json   # what would change, unresolved links
llm-wiki --wiki notes convert --to html --json
```
Every page keeps its id and metadata. Bodies are rendered to HTML; `[[wikilinks]]`, `[[raw/…]]` and relative
`[text](page.md)` links become relative `.html` links (links to missing pages become dashed "missing" links
and are listed in `unresolvedLinks`). The log is re-rendered entry by entry, the index, `wiki.css` and the
search index are rebuilt, and a `convert` entry is logged. The markdown files (pages, `index.md`, `log.md`, replaced schema files) are moved to `.llm-wiki/backup/markdown-<timestamp>/`,
so the change can be undone by hand. No LLM is called.

`CLAUDE.md` / `AGENTS.md`: the stock schema is replaced by the HTML one; a customised schema is **merged** —
the sections the template owns (Layout, Page format, Operations, Tools, Working style) are replaced by their
HTML versions, every other section (e.g. your domain conventions) is kept. `--keep-schema` leaves both files
untouched. Embeddings are recomputed on the next `index --embed`, because page text changes slightly.

## 12. Keep outside sources current

Web pages (URLs) and files ingested from outside the wiki folder are remembered with their SHA-256. Check them:
```bash
llm-wiki --wiki research sources check --json        # unchanged | changed | missing | error, per source
llm-wiki --wiki research sources update --dry-run    # what would be re-ingested
llm-wiki --wiki research sources update --json       # re-ingest the changed ones
```
URLs are re-requested with `If-None-Match` / `If-Modified-Since` first (a 304 means unchanged); web pages
are compared by the hash of their readable text, so markup, scripts, ads and timestamps do not count as
changes; pages printed to PDF are compared by their rendered text; everything else by bytes. A changed source
is kept as a new, dated raw original (`raw/notes-2026-10-17.md`, `raw/web/<name>-2026-10-17.html`) — the old
copy stays — and is ingested again, so the wiki pages are updated from the new version.

## 13. Browse wikis in a desktop app

`wiki-explorer` (a SwiftUI macOS app next to the llm-wiki repo) is a graphical front end built entirely on
this CLI's JSON: `wikis list`, `pages`, `show`, `graph`, `search`, `query`, `ingest` (files and URLs) and `init`. It
renders pages from `show --json`, follows the `llmwiki://` links, and draws the wiki as an interactive graph
from `graph --json`. Any other viewer can do the same.
