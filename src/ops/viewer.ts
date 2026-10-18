/**
 * Data for graphical viewers (such as the wiki-explorer app): page lists, a page rendered to HTML with
 * its links and backlinks, and query answers rendered with resolved citations.
 *
 * Links in the HTML produced here use one URL scheme, so a viewer can intercept them:
 *   llmwiki://open?wiki=<name>&page=<page-id>   another wiki page
 *   llmwiki://open?wiki=<name>&raw=<raw/path>   a source file under raw/
 * External links (https://, mailto:) are left as they are.
 */
import fs from 'node:fs';
import path from 'node:path';
import { asStringList, type Frontmatter } from '../wiki/markdown.js';
import { decodeEntities, escapeHtml, renderWithLinks } from '../wiki/format.js';
import { LinkResolver, listPages, normalisePageId, readPage, WIKI_DIR, type Page, type WikiPaths } from '../wiki/layout.js';
import { WikiLayoutError } from '../errors.js';

export function viewerUrl(wiki: string, target: { page: string } | { raw: string }): string {
  const q = new URLSearchParams({ wiki, ...target });
  return `llmwiki://open?${q.toString()}`;
}

export interface PageSummary {
  id: string;
  path: string;
  title: string;
  type: string;
  summary: string | null;
  updated: string | null;
  sources: string[];
}

function summaryOf(p: Page): PageSummary {
  const fm = p.frontmatter;
  return {
    id: p.id,
    path: p.relPath,
    title: p.title,
    type: p.type,
    summary: typeof fm.summary === 'string' && fm.summary.trim() !== '' ? fm.summary.trim() : null,
    updated: typeof fm.updated === 'string' ? fm.updated : null,
    sources: asStringList(fm.sources),
  };
}

/** Every page of a wiki with the fields a page list needs. */
export function listPageSummaries(paths: WikiPaths): PageSummary[] {
  return listPages(paths).map(summaryOf);
}

/**
 * Rewrites the relative links of a rendered body (`../concepts/x.html`, `x.md`, `../../raw/doc.pdf`) to
 * `llmwiki://` URLs, and relative image sources to absolute `file://` URLs.
 */
function rewriteRelativeLinks(html: string, paths: WikiPaths, wiki: string, fromId: string, ids: Set<string>): string {
  const fromDir = path.posix.dirname(`${WIKI_DIR}/${fromId}`);
  const resolveRel = (href: string) => {
    let clean = decodeEntities(href).replace(/[?#].*$/, '');
    try {
      clean = decodeURIComponent(clean);
    } catch {
      /* keep as written */
    }
    return path.posix.normalize(path.posix.join(fromDir, clean));
  };
  const isExternal = (href: string) => href === '' || href.startsWith('#') || href.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(href);
  return html
    .replace(/\bhref="([^"]*)"|\bhref='([^']*)'/g, (m, dq: string | undefined, sq: string | undefined) => {
      const href = dq ?? sq ?? '';
      if (isExternal(href)) return m;
      const rel = resolveRel(href);
      if (rel.startsWith('raw/')) return `href="${escapeHtml(viewerUrl(wiki, { raw: rel }))}"`;
      if (rel.startsWith(`${WIKI_DIR}/`) && /\.(md|html?)$/i.test(rel)) {
        const id = rel.slice(WIKI_DIR.length + 1).replace(/\.(md|html?)$/i, '');
        if (ids.has(id)) return `href="${escapeHtml(viewerUrl(wiki, { page: id }))}"`;
        return `href="${escapeHtml(viewerUrl(wiki, { page: id }))}" data-missing="true"`;
      }
      return m;
    })
    .replace(/\bsrc="([^"]*)"|\bsrc='([^']*)'/g, (m, dq: string | undefined, sq: string | undefined) => {
      const src = dq ?? sq ?? '';
      if (isExternal(src)) return m;
      const abs = path.join(paths.root, resolveRel(src));
      if (!abs.startsWith(paths.root + path.sep)) return m;
      return `src="${escapeHtml(`file://${abs.split(path.sep).map(encodeURIComponent).join('/')}`)}"`;
    });
}

/**
 * Links whose text is just the page id (a `[[folder/slug]]` written without a display name) show the
 * page title instead; links with their own text are left alone.
 */
export function retitleLinks(html: string, titleOf: (wiki: string, id: string) => string | undefined): string {
  return html.replace(/(<a\b[^>]*\bhref="llmwiki:\/\/open\?([^"]*)"[^>]*>)([^<]*)(<\/a>)/g, (m, open: string, query: string, text: string, close: string) => {
    const q = new URLSearchParams(decodeEntities(query));
    const wiki = q.get('wiki');
    const id = q.get('page');
    if (!wiki || !id) return m;
    const shown = decodeEntities(text).trim().replace(/\.(md|html?)$/i, '').replace(/^wiki\//, '');
    if (shown !== id && shown !== path.posix.basename(id) && shown !== `${wiki}:${id}`) return m;
    const title = titleOf(wiki, id);
    return title ? `${open}${escapeHtml(title)}${close}` : m;
  });
}

export interface PageView extends PageSummary {
  wiki: string;
  format: string;
  abs: string;
  frontmatter: Frontmatter;
  /** The page body as sanitised HTML with `llmwiki://` links. */
  html: string;
  /** Pages this page links to. */
  links: Array<{ id: string; title: string }>;
  /** Pages that link to this page. */
  backlinks: Array<{ id: string; title: string }>;
  /** `sources` that exist under raw/, with their absolute paths. */
  sourceFiles: Array<{ path: string; abs: string; exists: boolean }>;
}

/** One page, rendered for a viewer, with its outgoing links and backlinks. */
export function viewPage(paths: WikiPaths, wiki: string, idOrPath: string): PageView {
  const id = normalisePageId(idOrPath);
  const pages = listPages(paths);
  const page = pages.find((p) => p.id === id);
  if (!page) throw new WikiLayoutError(`Page not found: ${id}. List the pages with \`llm-wiki pages\`.`);
  const resolver = new LinkResolver(pages);
  const ids = new Set(pages.map((p) => p.id));
  const resolveTo = (t: string) => (t.startsWith('raw/') ? t : resolver.resolve(t, page.id)?.id);
  // Markdown bodies become HTML with relative links (the HTML format's own rendering); HTML bodies already are.
  const relative = paths.format.name === 'markdown' ? renderWithLinks(page.body, (target, label) => {
    const r = resolveTo(target);
    const href = r === undefined ? `${target}.md` : r.startsWith('raw/') ? path.posix.relative(path.posix.dirname(`${WIKI_DIR}/${page.id}`), r) : path.posix.relative(path.posix.dirname(page.id), r) + '.md';
    return `<a class="wikilink${r === undefined ? ' wikilink-missing' : ''}" href="${escapeHtml(href)}">${label}</a>`;
  }) : renderWithLinks(page.body, (target, label) => {
    const r = resolveTo(target);
    return r === undefined ? `<a class="wikilink wikilink-missing" href="${escapeHtml(viewerUrl(wiki, { page: target }))}" data-missing="true">${label}</a>` : `<a class="wikilink" href="${escapeHtml(viewerUrl(wiki, r.startsWith('raw/') ? { raw: r } : { page: r }))}">${label}</a>`;
  });
  const titleOf = new Map(pages.map((p) => [p.id, p.title]));
  const html = retitleLinks(rewriteRelativeLinks(relative, paths, wiki, page.id, ids), (w, id) => (w === wiki ? titleOf.get(id) : undefined));
  const outgoing = new Map<string, string>();
  for (const l of page.links) {
    const t = l.target.startsWith('raw/') ? undefined : resolver.resolve(l.target, page.id);
    if (t && t.id !== page.id) outgoing.set(t.id, t.title);
  }
  const backlinks = pages
    .filter((p) => p.id !== page.id && p.links.some((l) => !l.target.startsWith('raw/') && resolver.resolve(l.target, p.id)?.id === page.id))
    .map((p) => ({ id: p.id, title: titleOf.get(p.id)! }));
  const summary = summaryOf(page);
  return {
    ...summary,
    wiki,
    format: paths.format.name,
    abs: page.abs,
    frontmatter: page.frontmatter,
    html,
    links: [...outgoing].map(([id, title]) => ({ id, title })),
    backlinks,
    sourceFiles: summary.sources.map((s) => {
      const abs = path.join(paths.root, s);
      return { path: s, abs, exists: abs.startsWith(paths.root + path.sep) && fs.existsSync(abs) };
    }),
  };
}

export interface Citation {
  wiki: string;
  id: string;
  title: string;
  path: string;
}

/**
 * Renders a query answer (markdown citing `[[page]]` or `[[wiki:page]]`) to HTML whose citations are
 * `llmwiki://` links, and lists the distinct pages it cites, in order of first citation.
 */
export function renderAnswer(answer: string, wikis: Array<{ name: string; paths: WikiPaths }>): { html: string; citations: Citation[] } {
  const byName = new Map(wikis.map((w) => [w.name, { ...w, pages: listPages(w.paths) }]));
  const resolvers = new Map([...byName].map(([n, w]) => [n, new LinkResolver(w.pages)]));
  const single = wikis.length === 1 ? wikis[0]!.name : undefined;
  const citations: Citation[] = [];
  const seen = new Set<string>();
  const html = renderWithLinks(answer, (target, label) => {
    const colon = target.indexOf(':');
    let wiki = single;
    let ref = target;
    if (colon > 0 && byName.has(target.slice(0, colon))) {
      wiki = target.slice(0, colon);
      ref = target.slice(colon + 1);
    }
    const w = wiki ? byName.get(wiki) : undefined;
    if (!w || !wiki) return `<span class="wikilink-missing">${label}</span>`;
    if (ref.startsWith('raw/')) return `<a class="wikilink" href="${escapeHtml(viewerUrl(wiki, { raw: ref }))}">${label}</a>`;
    const page = resolvers.get(wiki)!.resolve(ref);
    if (!page) return `<span class="wikilink-missing" title="no such page in ${escapeHtml(wiki)}">${label}</span>`;
    const key = `${wiki}:${page.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      citations.push({ wiki, id: page.id, title: page.title, path: page.relPath });
    }
    return `<a class="wikilink" href="${escapeHtml(viewerUrl(wiki, { page: page.id }))}">${label}</a>`;
  });
  const titles = new Map([...byName].map(([n, w]) => [n, new Map(w.pages.map((p) => [p.id, p.title]))]));
  return { html: retitleLinks(html, (w, id) => titles.get(w)?.get(id)), citations };
}

/** Reads one page for a viewer when only the path is known (used by tests and tools). */
export function pageByPath(paths: WikiPaths, rel: string): Page {
  return readPage(paths, path.join(paths.root, rel));
}

export interface GraphNode {
  id: string;
  title: string;
  type: string;
  summary: string | null;
  /** Distinct pages linked to or from this page. */
  degree: number;
}

export interface GraphView {
  wiki: string;
  format: string;
  nodes: GraphNode[];
  /** Page-to-page links, one per pair and direction (`from` links to `to`); self-links are left out. */
  links: Array<{ from: string; to: string }>;
  /** The files under raw/ that pages name in `sources`, with the pages that cite them. */
  sources: Array<{ path: string; exists: boolean; pages: string[] }>;
  /** Links whose target page does not exist. */
  missing: Array<{ from: string; target: string }>;
}

/** The whole wiki as a graph for viewers: pages, the links between them, and the source files behind them. */
export function viewGraph(paths: WikiPaths, wiki: string): GraphView {
  const pages = listPages(paths);
  const resolver = new LinkResolver(pages);
  const links: GraphView['links'] = [];
  const missing: GraphView['missing'] = [];
  const seen = new Set<string>();
  const neighbours = new Map(pages.map((p) => [p.id, new Set<string>()]));
  for (const page of pages) {
    for (const l of page.links) {
      if (l.target.startsWith('raw/')) continue;
      const t = resolver.resolve(l.target, page.id);
      if (!t) {
        missing.push({ from: page.id, target: l.target });
        continue;
      }
      const key = `${page.id}\u0000${t.id}`;
      if (t.id === page.id || seen.has(key)) continue;
      seen.add(key);
      links.push({ from: page.id, to: t.id });
      neighbours.get(page.id)!.add(t.id);
      neighbours.get(t.id)!.add(page.id);
    }
  }
  const cited = new Map<string, string[]>();
  for (const page of pages) {
    for (const s of asStringList(page.frontmatter.sources)) {
      const list = cited.get(s) ?? [];
      if (!list.includes(page.id)) list.push(page.id);
      cited.set(s, list);
    }
  }
  return {
    wiki,
    format: paths.format.name,
    nodes: pages.map((p) => ({ ...pick(summaryOf(p)), degree: neighbours.get(p.id)!.size })),
    links,
    sources: [...cited].sort(([a], [b]) => a.localeCompare(b)).map(([s, ids]) => {
      const abs = path.join(paths.root, s);
      return { path: s, exists: abs.startsWith(paths.root + path.sep) && fs.existsSync(abs), pages: ids };
    }),
    missing,
  };
}

function pick(s: PageSummary): Omit<GraphNode, 'degree'> {
  return { id: s.id, title: s.title, type: s.type, summary: s.summary };
}
