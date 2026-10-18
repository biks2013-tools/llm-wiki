# Output conventions and JSON shapes

- **stdout** carries the result; **stderr** carries progress, the `wiki: <name> — <root>` line, notes and
  errors. Parse stdout only.
- Every command an agent needs has `--json`. With `--json`, stdout is exactly one JSON document.
- Paths are root-relative (`wiki/...`, `raw/...`). Combine with the wiki's `root` to read files.

## `wikis list --json`
```json
[{ "name": "work", "root": "/abs/path", "description": "Work docs", "healthy": true, "format": "markdown",
   "pages": 42, "pending": 1, "lastActivity": "2026-10-16 ingest | Q3 plan", "current": true }]
```
Unhealthy entries have `"healthy": false` and `"problem": "<reason>"` instead of counts.

## `wikis show [name] --json`
Same fields as one list row plus `"registered": "YYYY-MM-DD"`.

## `search --json`
```json
[{ "wiki": "work", "file": "wiki/concepts/deploy.md", "layer": "wiki", "title": "Deploy pipeline",
   "heading": "Rollback", "score": 0.29, "snippet": "…" }]
```
Scores are comparable within one call only. With several wikis, scores are rank-fusion values.

## `query --json` (one wiki; see below for several)
```json
{ "wiki": "work", "question": "…", "answer": "markdown with citations",
  "answerHtml": "<p>… <a class=\"wikilink\" href=\"llmwiki://open?wiki=work&amp;page=concepts%2Fdeploy\">Deploy pipeline</a></p>",
  "citations": [{ "wiki": "work", "id": "concepts/deploy", "title": "Deploy pipeline", "path": "wiki/concepts/deploy.md" }],
  "pagesUsed": ["wiki/concepts/deploy.md"], "filedAs": "wiki/syntheses/….md" }   // .html in HTML wikis
```
`filedAs` is null unless `--file`. `answerHtml` is the answer rendered to sanitised HTML with its citations
as `llmwiki://` links (see `show` below); `citations` lists the distinct pages it cites, in order.

With `--wikis a,b` / `--all-wikis` (more than one usable wiki):
```json
{ "wikis": ["ai-committee", "research"], "question": "…", "answer": "markdown citing [[wiki:page-id]]",
  "answerHtml": "…", "citations": [{ "wiki": "research", "id": "concepts/rag", "title": "RAG", "path": "wiki/concepts/rag.md" }],
  "pagesUsed": ["ai-committee:wiki/entities/sofia.html", "research:wiki/concepts/rag.md"] }
```

## `sources check --json`
```json
{ "wiki": "research", "sources": [
  { "kind": "url", "origin": "https://example.com/post", "raw": "raw/web/example.com-post.html",
    "status": "changed", "since": "2026-10-17T06:12:00.000Z" },
  { "kind": "file", "origin": "/Users/me/notes/plan.md", "raw": "raw/plan.md", "status": "missing",
    "detail": "the outside file no longer exists", "since": "…" } ] }
```
`status`: `unchanged`, `changed`, `missing` (outside file gone), `error` (`detail` says why). `sources update
--json` returns `{wiki, dryRun, checked: [...as above], updated: [{origin, source, original, skipped, title,
changes:[{op, page, reason}]}]}`.

## `pages --json`
```json
{ "wiki": "work", "format": "html", "root": "/abs/path",
  "pages": [{ "id": "concepts/deploy", "path": "wiki/concepts/deploy.html", "title": "Deploy pipeline",
              "type": "concept", "summary": "…", "updated": "2026-10-17", "sources": ["raw/notes.md"] }] }
```

## `show <page> --json`
```json
{ "wiki": "work", "format": "html", "id": "concepts/deploy", "path": "wiki/concepts/deploy.html",
  "abs": "/abs/path/wiki/concepts/deploy.html", "title": "Deploy pipeline", "type": "concept",
  "summary": "…", "updated": "2026-10-17", "sources": ["raw/notes.md"], "frontmatter": { "...": "..." },
  "html": "<h1>Deploy pipeline</h1>…",
  "links": [{ "id": "entities/ci", "title": "CI server" }], "backlinks": [{ "id": "sources/notes", "title": "Notes" }],
  "sourceFiles": [{ "path": "raw/notes.md", "abs": "/abs/path/raw/notes.md", "exists": true }] }
```
`html` is the page body as sanitised HTML in either format — markdown is rendered, `[[wikilinks]]` and relative
links resolved. Links use one URL scheme a viewer can intercept: `llmwiki://open?wiki=<name>&page=<page-id>`
for wiki pages, `llmwiki://open?wiki=<name>&raw=<raw/path>` for source files; external links are unchanged.
Links written without a display name show the page title.

## `graph --json`
```json
{ "wiki": "work", "format": "html",
  "nodes": [{ "id": "concepts/deploy", "title": "Deploy pipeline", "type": "concept", "summary": "…", "degree": 4 }],
  "links": [{ "from": "concepts/deploy", "to": "entities/ci" }],
  "sources": [{ "path": "raw/notes.md", "exists": true, "pages": ["sources/notes", "concepts/deploy"] }],
  "missing": [{ "from": "concepts/deploy", "target": "rollbacks" }] }
```
The whole wiki as a graph for viewers. `links` has one entry per pair and direction (a page linking to itself
is left out); `degree` counts the distinct pages linked to or from a page. `sources` lists the files named in
pages' `sources` metadata with the pages citing them; `missing` lists links to pages that do not exist.
Without `--json`: counts, the most connected pages, and the pages no other page links to or from.

## `ingest --json`
```json
{ "wiki": "work", "dryRun": false, "results": [
  { "source": "raw/report.pdf.md", "original": "raw/report.pdf", "skipped": false,
    "title": "Q3 report", "takeaways": ["…"],
    "changes": [{ "op": "create", "page": "wiki/sources/q3-report.md", "reason": "…" }] } ] }
```
`op` is `create`, `replace` or `append`. With `--dry-run` the changes are proposals; nothing is written.
`skipped: true` means the source was unchanged since its last ingest.

## `parse --json`
```json
{ "wiki": "work", "results": [{ "original": "raw/x.pdf", "markdown": "raw/x.pdf.md", "skipped": false }] }
```

## `convert --to html --json`
```json
{ "wiki": "notes", "from": "markdown", "to": "html", "dryRun": false,
  "pages": ["wiki/entities/ada-lovelace.html"], "logEntries": 84,
  "unresolvedLinks": [{ "page": "entities/ada-lovelace", "target": "ghost-page" }],
  "schema": "merged", "schemaSectionsReplaced": ["Layout (three layers)", "Page format", "Operations", "Tools"],
  "backup": ".llm-wiki/backup/markdown-20261017-051719" }
```
`schema` is `rewritten` (stock schema replaced), `merged` or `kept` (`--keep-schema`); `backup` is null on a dry run.

## `index --json`
```json
{ "wiki": "work", "format": "html", "indexChanged": true, "linkedPages": ["wiki/concepts/x.html"],
  "search": { "chunks": 310, "added": 2, "updated": 1, "unchanged": 40, "removed": 0 },
  "embeddings": { "computed": 12, "stored": 310, "provider": "openai", "model": "text-embedding-3-small" } }
```
`embeddings` is null without `--embed`. `linkedPages` lists HTML pages whose hand-typed `[[wikilinks]]` were converted (always empty in markdown wikis).

## `lint --json`
```json
{ "structural": { "pages": 42, "findings": [{ "severity": "warning", "code": "orphan-page",
                   "page": "entities/foo", "message": "…" }] },
  "semantic": null }
```
Codes: dangling-link, orphan-page, missing-frontmatter, missing-summary, missing-type, empty-page,
basename-collision, index-stale, raw-not-ingested, original-not-parsed, no-outbound-links.
With `--llm`, `semantic` has `contradictions`, `stale_claims`, `missing_pages`, `missing_links`,
`data_gaps`, `suggested_questions`, `suggested_sources`.

## `log --json`
```json
[{ "date": "2026-10-16", "kind": "ingest", "title": "Q3 report", "body": "…" }]
```

## `guide --json`
The guide topics plus a machine-readable tree of every command, argument and option.
