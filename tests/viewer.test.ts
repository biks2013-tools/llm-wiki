import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Config } from '../src/config/env.js';
import { applyPageChanges } from '../src/ops/pages.js';
import { listPageSummaries, renderAnswer, viewGraph, viewPage, viewerUrl } from '../src/ops/viewer.js';
import { fetchToRaw, isUrl, webPageToMarkdown } from '../src/ops/fetch.js';
import { ingestSource, pendingSources } from '../src/ops/ingest.js';
import { lintStructure } from '../src/wiki/lint.js';
import { parseFrontmatter } from '../src/wiki/markdown.js';
import { FakeChat, tempWiki } from './helpers.js';

const pagesFor = (format: 'markdown' | 'html') => {
  const paths = tempWiki(format);
  fs.writeFileSync(path.join(paths.raw, 'paper.pdf'), 'x');
  applyPageChanges(paths, [
    { op: 'create', path: 'entities/ada-lovelace', content: '---\ntitle: Ada Lovelace\nsummary: Mathematician.\nsources: [raw/paper.pdf]\n---\n# Ada Lovelace\n\nWorked on the [[analytical-engine|Engine]]; see [[raw/paper.pdf]] and [the source](../sources/paper.md) and [Wikipedia](https://en.wikipedia.org/wiki/Ada_Lovelace).' },
    { op: 'create', path: 'concepts/analytical-engine', content: '---\ntitle: Analytical Engine\n---\n# Analytical Engine\n\nProgrammed by [[ada-lovelace]].' },
    { op: 'create', path: 'sources/paper', content: '---\ntitle: Paper\n---\n# Paper\n\nAbout [[entities/ada-lovelace]].' },
  ]);
  return paths;
};

for (const format of ['markdown', 'html'] as const) {
  test(`viewPage (${format} wiki): HTML with llmwiki:// links, links and backlinks, source files`, () => {
    const paths = pagesFor(format);
    const v = viewPage(paths, 'demo', `wiki/entities/ada-lovelace.${format === 'html' ? 'html' : 'md'}`);
    assert.equal(v.title, 'Ada Lovelace');
    assert.equal(v.format, format);
    assert.match(v.html, /<h1>Ada Lovelace<\/h1>/);
    assert.ok(v.html.includes(`href="${viewerUrl('demo', { page: 'concepts/analytical-engine' }).replace(/&/g, '&amp;')}"`), v.html);
    assert.ok(v.html.includes(viewerUrl('demo', { raw: 'raw/paper.pdf' }).replace(/&/g, '&amp;')));
    assert.ok(v.html.includes(viewerUrl('demo', { page: 'sources/paper' }).replace(/&/g, '&amp;')), 'relative markdown links resolve too');
    assert.match(v.html, /href="https:\/\/en\.wikipedia\.org\/wiki\/Ada_Lovelace"/);
    assert.deepEqual(v.links.map((l) => l.id).sort(), ['concepts/analytical-engine', 'sources/paper']);
    assert.deepEqual(v.backlinks.map((l) => l.id).sort(), ['concepts/analytical-engine', 'sources/paper']);
    assert.deepEqual(v.sourceFiles.map((s) => [s.path, s.exists]), [['raw/paper.pdf', true]]);
    assert.deepEqual(listPageSummaries(paths).map((p) => p.id), ['concepts/analytical-engine', 'entities/ada-lovelace', 'sources/paper']);
    assert.throws(() => viewPage(paths, 'demo', 'nope'), /Page not found/);
  });
}

for (const format of ['markdown', 'html'] as const) {
  test(`viewGraph (${format} wiki): pages, links once per direction, cited sources, broken links`, () => {
    const paths = pagesFor(format);
    applyPageChanges(paths, [{ op: 'create', path: 'concepts/orphan', content: '---\ntitle: Orphan\nsources: [raw/gone.pdf]\n---\n# Orphan\n\nMentions [[nowhere]] twice: [[nowhere]].' }]);
    const g = viewGraph(paths, 'demo');
    assert.equal(g.format, format);
    assert.deepEqual(g.nodes.map((n) => [n.id, n.degree]), [['concepts/analytical-engine', 1], ['concepts/orphan', 0], ['entities/ada-lovelace', 2], ['sources/paper', 1]]);
    assert.deepEqual(g.links.map((l) => `${l.from}>${l.to}`).sort(), ['concepts/analytical-engine>entities/ada-lovelace', 'entities/ada-lovelace>concepts/analytical-engine', 'entities/ada-lovelace>sources/paper', 'sources/paper>entities/ada-lovelace']);
    assert.deepEqual(g.sources, [{ path: 'raw/gone.pdf', exists: false, pages: ['concepts/orphan'] }, { path: 'raw/paper.pdf', exists: true, pages: ['entities/ada-lovelace'] }]);
    assert.deepEqual(g.missing.map((m) => m.from), ['concepts/orphan', 'concepts/orphan']);
  });
}

test('renderAnswer: citations resolve in one or several wikis and become llmwiki:// links', () => {
  const a = pagesFor('markdown');
  const b = pagesFor('html');
  const one = renderAnswer('Ada wrote programs [[ada-lovelace]] for the [[analytical-engine|Engine]]; unknown [[ghost]].', [{ name: 'a', paths: a }]);
  assert.deepEqual(one.citations.map((c) => [c.wiki, c.id, c.title, c.path]), [['a', 'entities/ada-lovelace', 'Ada Lovelace', 'wiki/entities/ada-lovelace.md'], ['a', 'concepts/analytical-engine', 'Analytical Engine', 'wiki/concepts/analytical-engine.md']]);
  assert.match(one.html, /<span class="wikilink-missing"[^>]*>ghost<\/span>/);
  assert.match(one.html, />Ada Lovelace<\/a> for the <a[^>]*>Engine<\/a>/, 'bare ids show the page title; display names are kept');
  const many = renderAnswer('From both: [[a:entities/ada-lovelace]] and [[b:concepts/analytical-engine]].', [{ name: 'a', paths: a }, { name: 'b', paths: b }]);
  assert.deepEqual(many.citations.map((c) => `${c.wiki}:${c.path}`), ['a:wiki/entities/ada-lovelace.md', 'b:wiki/concepts/analytical-engine.html']);
  assert.ok(many.html.includes(viewerUrl('b', { page: 'concepts/analytical-engine' }).replace(/&/g, '&amp;')));
});

async function serve(routes: Record<string, { type: string; body: string | Buffer }>): Promise<{ base: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const r = routes[req.url ?? ''];
    if (!r) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', r.type);
    res.end(r.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

const PAGE = `<!doctype html><html><head><title>Deploying &amp; scaling</title><style>.x{}</style></head><body>
<nav><a href="/">Home</a> Menu Menu</nav><header>Site header</header>
<article><h1>Deploying &amp; scaling</h1><p>We deploy with <b>Docker</b> on Fridays.</p><p>Every release starts from a tagged commit on the main branch. The pipeline builds one image, runs the integration tests against a disposable database, and pushes the image to the registry only when every check passes. Rollbacks reuse the previous image tag, so they take seconds.</p><ul><li>Build</li><li>Ship</li></ul><script>alert(1)</script></article>
<footer>Copyright</footer></body></html>`;

test('webPageToMarkdown keeps the article and drops navigation, scripts and footers', () => {
  const { title, text } = webPageToMarkdown(PAGE);
  assert.equal(title, 'Deploying & scaling');
  assert.match(text, /# Deploying & scaling\n\nWe deploy with Docker on Fridays\./);
  assert.match(text, /- Build\n- Ship/);
  assert.doesNotMatch(text, /Menu|Site header|Copyright|alert/);
  assert.ok(isUrl('https://example.com/a?b=1') && !isUrl('raw/x.md') && !isUrl('ftp://x'));
});

test('URL ingest: web page saved and converted, re-download reused, changes kept as a new original', async () => {
  const routes: Record<string, { type: string; body: string | Buffer }> = { '/blog/deploy': { type: 'text/html; charset=utf-8', body: PAGE }, '/notes.txt': { type: 'text/plain', body: 'plain notes' }, '/bin': { type: 'application/octet-stream', body: 'zz' } };
  const srv = await serve(routes);
  try {
    const paths = tempWiki('html');
    const f = await fetchToRaw(paths, `${srv.base}/blog/deploy`, { maxBytes: 1_000_000 });
    assert.equal(f.originalRel, 'raw/web/127.0.0.1-blog-deploy.html');
    assert.equal(f.sourceRel, 'raw/web/127.0.0.1-blog-deploy.html.md');
    const md = parseFrontmatter(fs.readFileSync(path.join(paths.root, f.sourceRel), 'utf8'));
    assert.equal(md.frontmatter.url, `${srv.base}/blog/deploy`);
    assert.equal(md.frontmatter.original, f.originalRel);
    assert.match(md.body, /Fetched from <http:\/\/127\.0\.0\.1:\d+\/blog\/deploy>/);
    assert.deepEqual(pendingSources(paths), [f.sourceRel], 'the HTML snapshot itself is not a pending source');
    assert.equal((await fetchToRaw(paths, `${srv.base}/blog/deploy`, { maxBytes: 1_000_000 })).downloaded, false);
    routes['/blog/deploy'] = { type: 'text/html', body: PAGE.replace('Fridays', 'Mondays') };
    const changed = await fetchToRaw(paths, `${srv.base}/blog/deploy`, { maxBytes: 1_000_000 });
    assert.match(changed.originalRel, /^raw\/web\/127\.0\.0\.1-blog-deploy-\d{4}-\d{2}-\d{2}\.html$/);
    assert.ok(fs.readFileSync(path.join(paths.root, f.originalRel), 'utf8').includes('Fridays'), 'the first original is untouched');

    const txt = await fetchToRaw(paths, `${srv.base}/notes.txt`, { maxBytes: 1_000_000 });
    assert.equal(txt.sourceRel, 'raw/web/127.0.0.1-notes.txt');
    await assert.rejects(fetchToRaw(paths, `${srv.base}/bin`, { maxBytes: 1_000_000 }), /cannot ingest/);
    await assert.rejects(fetchToRaw(paths, `${srv.base}/missing`, { maxBytes: 1_000_000 }), /HTTP 404/);
    await assert.rejects(fetchToRaw(paths, `${srv.base}/blog/deploy`, { maxBytes: 10 }), /--max-bytes/);

    const plan = JSON.stringify({ title: 'Deploying', takeaways: ['Docker'], summary_page: { path: 'sources/deploying', content: '---\ntitle: Deploying\n---\n<h1>Deploying</h1><p>Docker on Mondays.</p>' }, pages: [], log_entry: 'Web page.' });
    const llm = new FakeChat([plan]);
    const r = await ingestSource(Config.fromValues({}), paths, llm, `${srv.base}/blog/deploy`, { force: false, dryRun: false, maxTokens: 1000, relatedLimit: 4, maxSourceChars: 100000, contextChars: 10000 });
    assert.equal(r.sourceRel, `${changed.originalRel}.md`);
    assert.equal(r.originalRel, changed.originalRel);
    assert.match(llm.requests[0]!.user, /We deploy with Docker on Mondays/);
    assert.ok(!lintStructure(paths).findings.some((x) => x.message.includes(changed.originalRel) && x.code === 'raw-not-ingested' && !x.message.includes('.html.md')));
  } finally {
    srv.close();
  }
});
