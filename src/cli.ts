#!/usr/bin/env node
import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Command, InvalidArgumentError } from 'commander';
import { Config, ensureToolConfigDir, registryFile, toolConfigDir } from './config/env.js';
import { requireWiki, resolveWiki, type ResolvedWiki } from './config/settings.js';
import { LlmWikiError, WikiLayoutError } from './errors.js';
import { slugWikiName, WikiRegistry } from './wiki/registry.js';
import { todayIso } from './wiki/markdown.js';
import { searchWikis, wikiStatus } from './ops/wikis.js';
import { createChatClient, createEmbeddingClient, createParserClient } from './llm/factory.js';
import { embedMissing, search, type SearchMode } from './search/search.js';
import { EmbeddingStore, SearchStore } from './search/store.js';
import { embeddingSettings } from './config/settings.js';
import { WikiPaths } from './wiki/layout.js';
import { writeIndex } from './wiki/index.js';
import { readLog } from './wiki/log.js';
import { formatLintReport, lintStructure } from './wiki/lint.js';
import { initWiki, isExistingWiki } from './ops/init.js';
import { linkHtmlPages } from './ops/pages.js';
import { convertToHtml } from './ops/convert.js';
import { listPageSummaries, renderAnswer, viewGraph, viewPage } from './ops/viewer.js';
import { checkSources, chromiumRenderer, fetchToRaw, isUrl, type PageRenderer, type SourceCheck } from './ops/fetch.js';
import { browserPath } from './config/settings.js';
import { parseWikiFormat } from './wiki/format.js';
import { ingestSource, pendingSources } from './ops/ingest.js';
import { parseDocument } from './ops/parse.js';
import { isParsableDocument } from './ops/extract.js';
import { queryWiki, queryWikis, type WikiTarget } from './ops/query.js';
import { fileLintReport, lintSemantic, renderSemanticLint } from './ops/lint-llm.js';
import { serveMcp } from './mcp/server.js';
import { GUIDE_TOPICS, guideJson, parseTopic, renderGuide, renderTopic } from './guide.js';

const VERSION = '0.6.0';

const program = new Command();
const info = (msg: string) => process.stderr.write(`${msg}\n`);

function intArg(v: string): number {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('expected a positive integer');
  return n;
}
function modeArg(v: string): SearchMode {
  if (v === 'bm25' || v === 'vector' || v === 'hybrid') return v;
  throw new InvalidArgumentError('expected bm25, vector or hybrid');
}

interface GlobalOpts {
  root?: string;
  wiki?: string;
  pick?: boolean;
  provider?: string;
  model?: string;
}

function loadConfig(): Config {
  ensureToolConfigDir();
  const g = program.opts<GlobalOpts>();
  if (g.root && g.wiki) throw new LlmWikiError('Pass either --root or --wiki, not both.');
  return Config.load({ LLM_WIKI_ROOT: g.root, LLM_WIKI_NAME: g.wiki, LLM_WIKI_PROVIDER: g.provider, LLM_WIKI_MODEL: g.model });
}

function openRegistry(): WikiRegistry {
  ensureToolConfigDir();
  return new WikiRegistry(registryFile());
}

/** Asks on the terminal which registered wiki to use. Only called when stdin/stderr are a TTY. */
async function pickWiki(registry: WikiRegistry, purpose: string): Promise<ResolvedWiki> {
  const wikis = registry.list();
  if (wikis.length === 0) throw new LlmWikiError('No wikis are registered yet: create one with `llm-wiki init <dir> --name <name>`.');
  info(`Which wiki should ${purpose} use?`);
  wikis.forEach((w, i) => info(`  ${i + 1}) ${w.name}${w.name === registry.current ? ' (current)' : ''} — ${w.description ?? w.root}`));
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question('number or name: ')).trim();
    const byNumber = /^\d+$/.test(answer) ? wikis[Number(answer) - 1] : undefined;
    const e = byNumber ?? registry.get(answer);
    return { root: e.root, name: e.name, via: 'LLM_WIKI_NAME' };
  } finally {
    rl.close();
  }
}

/** Name of the wiki chosen by the last openWiki() call, for JSON output. */
let selectedWikiName: string | null = null;

const interactive = () => process.stdin.isTTY === true && process.stderr.isTTY === true;

/**
 * Resolves the wiki a command works on: --root / --wiki / LLM_WIKI_ROOT / LLM_WIKI_NAME, then the
 * registry's current selection. `--pick`, or no selection at all on a terminal, asks interactively.
 */
async function openWiki(config: Config, purpose: string): Promise<WikiPaths> {
  const registry = openRegistry();
  const g = program.opts<GlobalOpts>();
  let resolved: ResolvedWiki | undefined;
  if (g.pick) {
    if (!interactive()) throw new LlmWikiError('--pick needs an interactive terminal; pass --wiki <name> instead.');
    resolved = await pickWiki(registry, purpose);
  } else {
    resolved = resolveWiki(config, registry);
    if (!resolved && interactive() && registry.size > 0) resolved = await pickWiki(registry, purpose);
    if (!resolved) resolved = requireWiki(config, registry);
  }
  const paths = new WikiPaths(resolved.root);
  paths.assertInitialised();
  info(`wiki: ${resolved.name ?? '(unregistered)'} — ${paths.root}`);
  selectedWikiName = resolved.name ?? null;
  return paths;
}

/** Opens the wikis named by --wikis a,b or --all-wikis (unusable wikis are skipped with --all-wikis, fatal otherwise). */
function openWikis(opts: { wikis?: string | undefined; allWikis: boolean }): WikiTarget[] {
  if (opts.wikis && opts.allWikis) throw new LlmWikiError('Pass either --wikis or --all-wikis, not both.');
  const registry = openRegistry();
  const entries = opts.allWikis ? registry.list() : [...new Set(opts.wikis!.split(',').map((n) => n.trim()).filter(Boolean))].map((n) => registry.get(n));
  if (entries.length === 0) throw new LlmWikiError('No wikis are registered.');
  const targets: WikiTarget[] = [];
  for (const e of entries) {
    const paths = new WikiPaths(e.root);
    try {
      paths.assertInitialised();
    } catch (err) {
      if (opts.allWikis && err instanceof WikiLayoutError) {
        info(`skipping "${e.name}": ${err.message}`);
        continue;
      }
      throw err;
    }
    targets.push({ name: e.name, paths, description: e.description });
  }
  info(`wikis: ${targets.map((t) => t.name).join(', ')}`);
  return targets;
}

program
  .name('llm-wiki')
  .description("Karpathy-style LLM wiki: compile raw sources into an interlinked markdown or HTML wiki and search it locally.")
  .version(VERSION)
  .option('--wiki <name>', 'registered wiki to work on (overrides LLM_WIKI_NAME and the current selection)')
  .option('--root <dir>', 'wiki root directory (overrides LLM_WIKI_ROOT); an alternative to --wiki')
  .option('--pick', 'choose the wiki interactively from the registry for this command', false)
  .option('--provider <name>', 'chat provider (overrides LLM_WIKI_PROVIDER)')
  .option('--model <name>', 'chat model (overrides LLM_WIKI_MODEL)')
  .option('--verbose', 'print stack traces for unexpected errors', false)
  .addHelpText(
    'after',
    `
Choosing the wiki: --wiki <name> (or --root <dir>), else the current selection from \`llm-wiki wikis use\`.

Full documentation, written for people and AI agents (e.g. to build a Claude skill):
  llm-wiki guide                 the complete guide (markdown)
  llm-wiki guide --topics        list the topics
  llm-wiki guide <topic>         one topic, e.g. workflows, selection, output, errors, skill
  llm-wiki guide --json          everything, machine-readable (topics + command tree)`,
  );

program
  .command('init')
  .description('create the raw/, wiki/ and schema layout in a directory')
  .argument('<dir>', 'directory to initialise (created if missing)')
  .option('--format <format>', 'page format of a new wiki: markdown or html (or LLM_WIKI_FORMAT); a markdown wiki can later be converted with `convert --to html`')
  .option('--force', 'rewrite CLAUDE.md/AGENTS.md even if they exist', false)
  .option('--name <name>', 'name to register the wiki under (default: derived from the directory name)')
  .option('--description <text>', 'what this wiki is about, shown by `llm-wiki wikis list`')
  .option('--no-register', 'do not add the wiki to the registry')
  .option('--use', 'make it the current wiki (the first registered wiki becomes current automatically)', false)
  .action((dir: string, opts: { format?: string; force: boolean; name?: string; description?: string; register: boolean; use: boolean }) => {
    ensureToolConfigDir();
    const config = Config.load({ LLM_WIKI_FORMAT: opts.format });
    const formatValue = isExistingWiki(new WikiPaths(dir)) ? config.get('LLM_WIKI_FORMAT') : config.require('LLM_WIKI_FORMAT', 'The page format of the new wiki: markdown or html (--format).');
    const format = formatValue === undefined ? undefined : parseWikiFormat(formatValue, 'LLM_WIKI_FORMAT');
    const registry = opts.register ? openRegistry() : undefined;
    // Validate the name before touching the disk.
    const name = registry ? (opts.name ?? slugWikiName(dir)) : undefined;
    if (registry && name && registry.find(name) && registry.find(name)!.root !== new WikiPaths(dir).root) {
      throw new LlmWikiError(`A wiki named "${name}" is already registered (${registry.find(name)!.root}). Pass --name <other-name>.`);
    }
    const r = initWiki(dir, { force: opts.force, format });
    info(`initialised ${r.format} wiki at ${r.root}`);
    for (const c of r.created) info(`  created ${c}`);
    if (registry && name) {
      const existing = registry.nameForRoot(r.root);
      if (existing) info(`already registered as "${existing}"`);
      else {
        registry.add(name, r.root, { today: todayIso(), ...(opts.description ? { description: opts.description } : {}) });
        info(`registered as "${name}"`);
      }
      const regName = existing ?? name;
      if (opts.use || registry.current === undefined) {
        registry.use(regName);
        info(`"${regName}" is now the current wiki`);
      }
      info(`next: drop sources into ${r.root}/raw/, then run llm-wiki --wiki ${regName} ingest raw/<file>`);
    } else {
      info(`next: pass --root ${r.root} (or register it with llm-wiki wikis add <name> ${r.root}), drop sources into raw/, then run llm-wiki ingest raw/<file>`);
    }
  });

const wikis = program.command('wikis').description('manage the registry of wikis and choose which one commands use');

wikis
  .command('list', { isDefault: true })
  .description('list registered wikis (* marks the current one)')
  .option('--json', 'machine-readable output', false)
  .action((opts: { json: boolean }) => {
    const registry = openRegistry();
    const rows = registry.list().map((e) => ({ ...wikiStatus(e), current: e.name === registry.current }));
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return;
    }
    if (rows.length === 0) {
      process.stdout.write('No wikis registered. Create one with: llm-wiki init <dir> --name <name>\n');
      return;
    }
    for (const r of rows) {
      const stats = r.healthy ? `${r.format}, ${r.pages} page(s), ${r.pending} pending source(s)` : `UNAVAILABLE: ${r.problem}`;
      process.stdout.write(`${r.current ? '*' : ' '} ${r.name.padEnd(20)} ${r.root}\n    ${r.description ? `${r.description}\n    ` : ''}${stats}${r.lastActivity ? `; last: ${r.lastActivity}` : ''}\n`);
    }
  });

wikis
  .command('add')
  .description('register an existing, initialised wiki directory under a name')
  .argument('<name>', 'short name, e.g. work or personal')
  .argument('<dir>', 'wiki root created with `llm-wiki init`')
  .option('--description <text>', 'what this wiki is about')
  .option('--use', 'make it the current wiki', false)
  .action((name: string, dir: string, opts: { description?: string; use: boolean }) => {
    const registry = openRegistry();
    const e = registry.add(name, dir, { today: todayIso(), ...(opts.description ? { description: opts.description } : {}) });
    info(`registered "${e.name}" → ${e.root}`);
    if (opts.use || registry.current === undefined) {
      registry.use(e.name);
      info(`"${e.name}" is now the current wiki`);
    }
  });

wikis
  .command('use')
  .description('select the wiki that commands use when neither --wiki nor --root is given')
  .argument('[name]', 'registered wiki name; omit on a terminal to choose from a list')
  .action(async (name: string | undefined) => {
    const registry = openRegistry();
    let chosen = name;
    if (!chosen) {
      if (!interactive()) throw new LlmWikiError('Name the wiki: llm-wiki wikis use <name>');
      chosen = (await pickWiki(registry, 'commands')).name!;
    }
    const e = registry.use(chosen);
    info(`"${e.name}" is now the current wiki (${e.root})`);
    const config = loadConfig();
    for (const key of ['LLM_WIKI_ROOT', 'LLM_WIKI_NAME']) {
      const tier = config.source(key);
      if (tier && tier !== 'cli') info(`note: ${key} is set (${tier} tier) and takes precedence over the current selection`);
    }
  });

wikis
  .command('unset')
  .description('clear the current selection, so every command must name its wiki')
  .action(() => {
    openRegistry().clearCurrent();
    info('no current wiki; pass --wiki <name> or run llm-wiki wikis use <name>');
  });

wikis
  .command('current')
  .description('show which wiki commands will use, and why')
  .action(() => {
    const r = resolveWiki(loadConfig(), openRegistry());
    if (!r) {
      process.stdout.write('No wiki selected.\n');
      process.exitCode = 1;
      return;
    }
    const why = r.via === 'current' ? 'registry selection (wikis use)' : r.via === 'LLM_WIKI_NAME' ? 'LLM_WIKI_NAME / --wiki' : 'LLM_WIKI_ROOT / --root';
    process.stdout.write(`${r.name ?? '(unregistered)'}\t${r.root}\t(via ${why})\n`);
  });

wikis
  .command('show')
  .description('show details of one wiki (default: the selected one)')
  .argument('[name]')
  .option('--json', 'machine-readable output', false)
  .action((name: string | undefined, opts: { json: boolean }) => {
    const registry = openRegistry();
    const target = name ?? requireWiki(loadConfig(), registry).name;
    if (!target) throw new LlmWikiError('The selected wiki is not registered; register it with `llm-wiki wikis add <name> <dir>`.');
    const st = { ...wikiStatus(registry.get(target)), current: target === registry.current, registered: registry.get(target).registered };
    if (opts.json) process.stdout.write(`${JSON.stringify(st, null, 2)}\n`);
    else process.stdout.write(Object.entries(st).map(([k, v]) => `${k.padEnd(13)} ${String(v)}`).join('\n') + '\n');
  });

wikis
  .command('rename')
  .description('rename a registered wiki (files are not touched)')
  .argument('<old>')
  .argument('<new>')
  .action((from: string, to: string) => {
    const e = openRegistry().rename(from, to);
    info(`renamed "${from}" → "${e.name}"`);
  });

wikis
  .command('describe')
  .description('set or clear (no text) the description of a registered wiki')
  .argument('<name>')
  .argument('[text]')
  .action((name: string, text: string | undefined) => {
    openRegistry().describe(name, text);
    info(text ? `description of "${name}" updated` : `description of "${name}" cleared`);
  });

wikis
  .command('remove')
  .description('unregister a wiki; its files on disk are left untouched')
  .argument('<name>')
  .action((name: string) => {
    const e = openRegistry().remove(name);
    info(`unregistered "${e.name}"; ${e.root} was not modified`);
  });

program
  .command('ingest')
  .description('compile one or more raw sources into the wiki with the configured LLM')
  .argument('[files...]', 'source files (outside raw/ they are copied in) or http(s) URLs (downloaded into raw/web/); omit to ingest every pending source')
  .option('--force', 're-ingest even if the source is unchanged', false)
  .option('--dry-run', 'show the proposed page changes without writing', false)
  .option('--max-tokens <n>', 'reply token limit', intArg, 32000)
  .option('--related <n>', 'related pages to include as context', intArg, 8)
  .option('--context-chars <n>', 'character budget for related pages', intArg, 60000)
  .option('--max-source-chars <n>', 'refuse sources above this size instead of truncating', intArg, 300000)
  .option('--reparse', 're-convert PDF/DOCX/PPTX/XLSX/image originals even if their markdown is up to date', false)
  .option('--parse-max-tokens <n>', 'reply token limit for the parser LLM', intArg, 64000)
  .option('--max-bytes <n>', 'refuse originals (PDF, DOCX, PPTX, XLSX, images) above this many bytes', intArg, 30000000)
  .option('--max-images <n>', 'PPTX: send at most this many slide pictures to the parser LLM', intArg, 40)
  .option('--render', 'URLs: render every page in the headless browser and keep it as PDF (LLM_WIKI_BROWSER); pages that need JavaScript are rendered anyway', false)
  .option('--json', 'machine-readable output on stdout (progress stays on stderr)', false)
  .action(async (files: string[], opts: { force: boolean; dryRun: boolean; maxTokens: number; related: number; contextChars: number; maxSourceChars: number; reparse: boolean; parseMaxTokens: number; maxBytes: number; maxImages: number; render: boolean; json: boolean }) => {
    const config = loadConfig();
    const paths = await openWiki(config, 'ingest');
    const targets = files.length > 0 ? files : pendingSources(paths).map((rel) => `${paths.root}/${rel}`);
    const results: unknown[] = [];
    if (targets.length === 0) {
      info('nothing to ingest: every raw source is already compiled into the wiki');
      if (opts.json) process.stdout.write(`${JSON.stringify({ wiki: selectedWikiName, dryRun: opts.dryRun, results }, null, 2)}\n`);
      return;
    }
    const llm = createChatClient(config);
    let parser: ReturnType<typeof createParserClient> | undefined;
    const getParser = () => (parser ??= createParserClient(config));
    for (const file of targets) {
      const r = await ingestSource(config, paths, llm, file, {
        force: opts.force,
        dryRun: opts.dryRun,
        maxTokens: opts.maxTokens,
        relatedLimit: opts.related,
        contextChars: opts.contextChars,
        maxSourceChars: opts.maxSourceChars,
        parser: getParser,
        parse: { force: opts.reparse, maxTokens: opts.parseMaxTokens, maxBytes: opts.maxBytes, maxImages: opts.maxImages },
        fetch: { renderer: rendererFor(config), render: opts.render },
        onEvent: info,
      });
      if (opts.json) {
        results.push({
          source: r.sourceRel,
          original: r.originalRel ?? null,
          skipped: r.skipped,
          title: r.plan?.title ?? null,
          takeaways: r.plan?.takeaways ?? [],
          changes: opts.dryRun
            ? r.plan
              ? [{ op: 'replace', page: paths.pageRel(r.plan.summaryPage.path), reason: null }, ...r.plan.pages.map((p) => ({ op: p.op, page: paths.pageRel(p.path), reason: p.reason ?? null }))]
              : []
            : r.applied.map((a) => ({ op: a.op, page: paths.pageRel(a.id), reason: a.reason ?? null })),
        });
        continue;
      }
      if (r.skipped || !r.plan) continue;
      process.stdout.write(`# ${r.plan.title}\n\nSource: ${r.sourceRel}${r.originalRel ? ` (converted from ${r.originalRel})` : ''}\n\nTakeaways:\n${r.plan.takeaways.map((t) => `- ${t}`).join('\n')}\n\n`);
      if (opts.dryRun) {
        process.stdout.write(`Proposed changes (dry run):\n- replace ${r.plan.summaryPage.path}\n${r.plan.pages.map((p) => `- ${p.op} ${p.path}${p.reason ? ` — ${p.reason}` : ''}`).join('\n')}\n\n`);
      } else {
        process.stdout.write(`Pages written:\n${r.applied.map((a) => `- ${a.op} ${paths.pageRel(a.id)}${a.reason ? ` — ${a.reason}` : ''}`).join('\n')}\n\n`);
      }
    }
    if (opts.json) process.stdout.write(`${JSON.stringify({ wiki: selectedWikiName, dryRun: opts.dryRun, results }, null, 2)}\n`);
  });

program
  .command('parse')
  .description('convert originals into markdown without ingesting: PDF, DOCX, PPTX and images with the dedicated parser LLM, XLSX locally')
  .argument('<files...>', 'PDF, DOCX, PPTX, XLSX, PNG, JPEG, GIF or WebP files (outside raw/ they are copied in), or http(s) URLs (downloaded into raw/web/)')
  .option('--force', 're-convert even if the markdown is up to date', false)
  .option('--max-tokens <n>', 'reply token limit for the parser LLM', intArg, 64000)
  .option('--max-bytes <n>', 'refuse originals above this many bytes', intArg, 30000000)
  .option('--max-images <n>', 'PPTX: send at most this many slide pictures to the parser LLM', intArg, 40)
  .option('--render', 'URLs: render the page in the headless browser and keep it as PDF (LLM_WIKI_BROWSER)', false)
  .option('--json', 'machine-readable output', false)
  .action(async (files: string[], opts: { force: boolean; maxTokens: number; maxBytes: number; maxImages: number; render: boolean; json: boolean }) => {
    const config = loadConfig();
    const paths = await openWiki(config, 'parse');
    let client: ReturnType<typeof createParserClient> | undefined;
    const parser = () => (client ??= createParserClient(config));
    const results: Array<{ original: string; markdown: string; skipped: boolean }> = [];
    for (const arg of files) {
      let file = arg;
      if (isUrl(arg)) {
        const f = await fetchToRaw(paths, arg, { maxBytes: opts.maxBytes, renderer: rendererFor(config), render: opts.render, onEvent: info });
        if (f.sourceRel !== f.originalRel) {
          results.push({ original: f.originalRel, markdown: f.sourceRel, skipped: false });
          if (!opts.json) process.stdout.write(`converted: ${f.originalRel} -> ${f.sourceRel}\n`);
          continue;
        }
        if (!isParsableDocument(f.originalRel)) {
          if (!opts.json) process.stdout.write(`downloaded: ${f.originalRel} (a text source; ingest it directly)\n`);
          results.push({ original: f.originalRel, markdown: f.originalRel, skipped: true });
          continue;
        }
        file = f.originalRel;
      }
      const r = await parseDocument(paths, parser, file, { force: opts.force, maxTokens: opts.maxTokens, maxBytes: opts.maxBytes, maxImages: opts.maxImages, onEvent: info });
      results.push({ original: r.originalRel, markdown: r.markdownRel, skipped: r.skipped });
      if (!opts.json) process.stdout.write(`${r.skipped ? 'up to date' : 'converted'}: ${r.originalRel} -> ${r.markdownRel}\n`);
    }
    if (opts.json) process.stdout.write(`${JSON.stringify({ wiki: selectedWikiName, results }, null, 2)}\n`);
  });

program
  .command('query')
  .description('answer a question from a wiki (or several: --wikis / --all-wikis) with citations; --file stores the answer as a synthesis page')
  .argument('<question>')
  .option('--file', 'file the answer back into wiki/syntheses/', false)
  .option('--limit <n>', 'search hits to consider', intArg, 12)
  .option('--pages <n>', 'max pages to load into context', intArg, 8)
  .option('--context-chars <n>', 'character budget for pages', intArg, 80000)
  .option('--mode <mode>', 'bm25 | vector | hybrid (default: hybrid when embeddings exist, else bm25)', modeArg)
  .option('--max-tokens <n>', 'reply token limit', intArg, 16000)
  .option('--json', 'machine-readable output: {wiki, question, answer, pagesUsed, filedAs}; with several wikis {wikis, question, answer, pagesUsed}', false)
  .option('--wikis <names>', 'comma-separated registered wikis to answer from together (citations become [[wiki:page]])')
  .option('--all-wikis', 'answer from every registered wiki', false)
  .action(async (question: string, opts: { file: boolean; limit: number; pages: number; contextChars: number; mode?: SearchMode; maxTokens: number; json: boolean; wikis?: string; allWikis: boolean }) => {
    const config = loadConfig();
    if (opts.wikis || opts.allWikis) {
      const targets = openWikis(opts);
      if (targets.length > 1) {
        if (opts.file) throw new LlmWikiError('--file needs one target wiki; a cross-wiki answer cannot be filed. Ask again with --wiki <name> --file to keep it.');
        const llm = createChatClient(config);
        const r = await queryWikis(config, targets, llm, question, { limit: opts.limit, maxPages: opts.pages, contextChars: opts.contextChars, maxTokens: opts.maxTokens, mode: opts.mode, onEvent: info });
        if (opts.json) {
          const rendered = renderAnswer(r.answer, targets);
          process.stdout.write(`${JSON.stringify({ wikis: r.wikis, question, answer: r.answer, answerHtml: rendered.html, citations: rendered.citations, pagesUsed: r.pagesUsed }, null, 2)}\n`);
        }
        else process.stdout.write(`${r.answer}\n`);
        return;
      }
      if (targets.length === 0) throw new LlmWikiError('None of the wikis is usable.');
      const only = targets[0]!;
      selectedWikiName = only.name;
      const r = await queryWiki(config, only.paths, createChatClient(config), question, { limit: opts.limit, maxPages: opts.pages, contextChars: opts.contextChars, maxTokens: opts.maxTokens, mode: opts.mode, file: opts.file, onEvent: info });
      if (opts.json) {
        const rendered = renderAnswer(r.answer, [only]);
        process.stdout.write(`${JSON.stringify({ wiki: only.name, question, answer: r.answer, answerHtml: rendered.html, citations: rendered.citations, pagesUsed: r.pagesUsed.map((id) => only.paths.pageRel(id)), filedAs: r.filedAs ? only.paths.pageRel(r.filedAs) : null }, null, 2)}\n`);
      }
      else process.stdout.write(`${r.answer}\n`);
      return;
    }
    const paths = await openWiki(config, 'this query');
    const llm = createChatClient(config);
    const r = await queryWiki(config, paths, llm, question, { limit: opts.limit, maxPages: opts.pages, contextChars: opts.contextChars, maxTokens: opts.maxTokens, mode: opts.mode, file: opts.file, onEvent: info });
    if (opts.json) {
      const rendered = renderAnswer(r.answer, [{ name: wikiLabel(paths), paths }]);
      process.stdout.write(`${JSON.stringify({ wiki: selectedWikiName, question, answer: r.answer, answerHtml: rendered.html, citations: rendered.citations, pagesUsed: r.pagesUsed.map((id) => paths.pageRel(id)), filedAs: r.filedAs ? paths.pageRel(r.filedAs) : null }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${r.answer}\n`);
    if (r.filedAs) info(`filed as ${paths.pageRel(r.filedAs)}`);
  });

program
  .command('search')
  .description('local search over wiki pages (no LLM needed for bm25)')
  .argument('<query>')
  .option('--mode <mode>', 'bm25 | vector | hybrid', modeArg, 'bm25')
  .option('--limit <n>', 'hits to return', intArg, 10)
  .option('--layer <layer>', 'wiki | raw | all', (v: string) => { if (v === 'wiki' || v === 'raw' || v === 'all') return v; throw new InvalidArgumentError('expected wiki, raw or all'); }, 'wiki')
  .option('--json', 'machine-readable output', false)
  .option('--wikis <names>', 'comma-separated registered wikis to search together (results are rank-fused)')
  .option('--all-wikis', 'search every registered wiki', false)
  .action(async (query: string, opts: { mode: SearchMode; limit: number; layer: 'wiki' | 'raw' | 'all'; json: boolean; wikis?: string; allWikis: boolean }) => {
    const config = loadConfig();
    let targets: WikiTarget[];
    if (opts.wikis || opts.allWikis) targets = openWikis(opts);
    else {
      const paths = await openWiki(config, 'this search');
      targets = [{ name: openRegistry().nameForRoot(paths.root) ?? '(unregistered)', paths }];
    }
    const multi = targets.length > 1;
    const hits = await searchWikis(config, targets, query, { mode: opts.mode, limit: opts.limit, layer: opts.layer });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(hits.map((h) => ({ wiki: h.wiki, file: h.chunk.file, layer: h.chunk.layer, title: h.chunk.title, heading: h.chunk.heading, score: h.score, snippet: h.snippet })), null, 2)}\n`);
      return;
    }
    if (hits.length === 0) {
      process.stdout.write('No hits.\n');
      return;
    }
    hits.forEach((h, i) => process.stdout.write(`${i + 1}. ${multi ? `[${h.wiki}] ` : ''}${h.chunk.file}${h.chunk.heading ? ` › ${h.chunk.heading}` : ''}  (${h.score.toFixed(3)})\n   ${h.snippet}\n`));
  });

program
  .command('index')
  .description('regenerate the wiki index (index.md / index.html) and rebuild the search index incrementally')
  .option('--raw', 'also index raw/ sources for search', false)
  .option('--embed', 'compute missing embeddings with the configured embedding provider', false)
  .option('--json', 'machine-readable summary on stdout', false)
  .action(async (opts: { raw: boolean; embed: boolean; json: boolean }) => {
    const config = loadConfig();
    const paths = await openWiki(config, 'index');
    const linked = linkHtmlPages(paths);
    if (linked.length > 0) info(`converted [[wikilinks]] to HTML links in ${linked.length} page(s): ${linked.join(', ')}`);
    const changed = writeIndex(paths);
    info(`${paths.relToRoot(paths.index)} ${changed ? 'updated' : 'unchanged'}`);
    const store = new SearchStore(paths);
    const r = store.reindex({ includeRaw: opts.raw });
    let embedSummary: { computed: number; stored: number; provider: string; model: string } | null = null;
    info(`search index: ${r.chunks} chunk(s) — ${r.added} file(s) added, ${r.updated} updated, ${r.unchanged} unchanged, ${r.removed} removed`);
    if (opts.embed) {
      const { provider, model } = embeddingSettings(config);
      const embedStore = new EmbeddingStore(paths, provider, model);
      const n = await embedMissing(store, embedStore, createEmbeddingClient(config), { onProgress: (d, t) => info(`embedded ${d}/${t}`) });
      info(`embeddings: ${n} computed, ${embedStore.size} stored (${provider}/${model})`);
      if (opts.json) embedSummary = { computed: n, stored: embedStore.size, provider, model };
    }
    if (opts.json) process.stdout.write(`${JSON.stringify({ wiki: selectedWikiName, format: paths.format.name, indexChanged: changed, linkedPages: linked.map((id) => paths.pageRel(id)), search: r, embeddings: embedSummary }, null, 2)}\n`);
  });

program
  .command('lint')
  .description('health-check the wiki; --llm adds semantic checks (contradictions, stale claims, missing pages)')
  .option('--llm', 'run the semantic lint with the configured LLM', false)
  .option('--fix', 'regenerate the index and the search index (HTML wikis: also convert leftover [[wikilinks]])', false)
  .option('--report', 'file the findings as a wiki/lint/<date> page', false)
  .option('--json', 'machine-readable output', false)
  .option('--context-chars <n>', 'character budget for pages sent to the LLM', intArg, 200000)
  .option('--max-tokens <n>', 'reply token limit', intArg, 16000)
  .action(async (opts: { llm: boolean; fix: boolean; report: boolean; json: boolean; contextChars: number; maxTokens: number }) => {
    const config = loadConfig();
    const paths = await openWiki(config, 'lint');
    if (opts.fix) {
      linkHtmlPages(paths);
      writeIndex(paths);
      new SearchStore(paths).reindex({ includeRaw: false });
      info('index and search index regenerated');
    }
    const structural = lintStructure(paths);
    let semantic: Awaited<ReturnType<typeof lintSemantic>>['result'] | undefined;
    if (opts.llm) semantic = (await lintSemantic(paths, createChatClient(config), { contextChars: opts.contextChars, maxTokens: opts.maxTokens, onEvent: info })).result;
    if (opts.json) process.stdout.write(`${JSON.stringify({ structural, semantic }, null, 2)}\n`);
    else {
      process.stdout.write(`${formatLintReport(structural)}\n`);
      if (semantic) process.stdout.write(`\n${renderSemanticLint(semantic)}\n`);
    }
    if (opts.report) info(`filed as ${paths.pageRel(fileLintReport(paths, structural, semantic))}`);
    if (structural.findings.some((f) => f.severity === 'error')) process.exitCode = 1;
  });

/** Lazily builds the headless-browser renderer from LLM_WIKI_BROWSER (undefined when the setting is absent). */
function rendererFor(config: Config): (() => PageRenderer) | undefined {
  const browser = browserPath(config);
  return browser ? () => chromiumRenderer(browser) : undefined;
}

/** The name a viewer should use for this wiki in `llmwiki://` links. */
function wikiLabel(paths: WikiPaths): string {
  return selectedWikiName ?? openRegistry().nameForRoot(paths.root) ?? '(unregistered)';
}

const sources = program.command('sources').description('detect changes in outside sources (downloaded URLs, files copied in from outside the wiki) by SHA-256 and re-ingest them');

function printChecks(checks: SourceCheck[]): void {
  if (checks.length === 0) {
    process.stdout.write('No outside sources are tracked (URLs and files ingested from outside raw/ are).\n');
    return;
  }
  for (const c of checks) process.stdout.write(`${c.status.padEnd(9)} ${c.kind.padEnd(4)} ${c.origin}\n          → ${c.raw}${c.detail ? ` (${c.detail})` : ''}\n`);
}

sources
  .command('check', { isDefault: true })
  .description('compare every tracked outside source with its latest raw copy (writes nothing)')
  .option('--max-bytes <n>', 'refuse downloads above this many bytes', intArg, 30000000)
  .option('--json', 'machine-readable output: {wiki, sources:[{kind, origin, raw, status, detail, since}]}', false)
  .action(async (opts: { maxBytes: number; json: boolean }) => {
    const config = loadConfig();
    const paths = await openWiki(config, 'sources check');
    const checks = await checkSources(paths, { maxBytes: opts.maxBytes, renderer: rendererFor(config), onEvent: info });
    if (opts.json) process.stdout.write(`${JSON.stringify({ wiki: selectedWikiName, sources: checks }, null, 2)}\n`);
    else printChecks(checks);
  });

sources
  .command('update')
  .description('re-ingest every changed outside source: the new version is kept as a new raw original, then compiled into the wiki')
  .option('--dry-run', 'only report what would be re-ingested', false)
  .option('--max-bytes <n>', 'refuse downloads above this many bytes', intArg, 30000000)
  .option('--max-tokens <n>', 'reply token limit', intArg, 32000)
  .option('--json', 'machine-readable output: {wiki, dryRun, checked, updated:[{origin, source, title, changes}]}', false)
  .action(async (opts: { dryRun: boolean; maxBytes: number; maxTokens: number; json: boolean }) => {
    const config = loadConfig();
    const paths = await openWiki(config, 'sources update');
    const renderer = rendererFor(config);
    const checks = await checkSources(paths, { maxBytes: opts.maxBytes, renderer, onEvent: info });
    const changed = checks.filter((c) => c.status === 'changed');
    const updated: unknown[] = [];
    if (!opts.dryRun && changed.length > 0) {
      const llm = createChatClient(config);
      let parser: ReturnType<typeof createParserClient> | undefined;
      for (const c of changed) {
        info(`updating ${c.origin}`);
        const r = await ingestSource(config, paths, llm, c.origin, {
          force: false, dryRun: false, maxTokens: opts.maxTokens, relatedLimit: 8, maxSourceChars: 300000, contextChars: 60000,
          parser: () => (parser ??= createParserClient(config)),
          parse: { force: false, maxTokens: 64000, maxBytes: opts.maxBytes, maxImages: 40 },
          fetch: { renderer },
          onEvent: info,
        });
        updated.push({ origin: c.origin, source: r.sourceRel, original: r.originalRel ?? null, skipped: r.skipped, title: r.plan?.title ?? null, changes: r.applied.map((a) => ({ op: a.op, page: paths.pageRel(a.id), reason: a.reason ?? null })) });
      }
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ wiki: selectedWikiName, dryRun: opts.dryRun, checked: checks, updated }, null, 2)}\n`);
      return;
    }
    printChecks(checks);
    process.stdout.write(changed.length === 0 ? '\nEverything is up to date.\n' : opts.dryRun ? `\n${changed.length} source(s) would be re-ingested.\n` : `\nRe-ingested ${updated.length} source(s).\n`);
  });

program
  .command('pages')
  .description('list the pages of a wiki (id, path, title, type, summary, updated, sources)')
  .option('--type <type>', 'only pages of this type (overview, entity, concept, source, synthesis, lint, other)')
  .option('--json', 'machine-readable output: {wiki, format, root, pages:[...]}', false)
  .action(async (opts: { type?: string; json: boolean }) => {
    const paths = await openWiki(loadConfig(), 'pages');
    const pages = listPageSummaries(paths).filter((p) => !opts.type || p.type === opts.type);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ wiki: wikiLabel(paths), format: paths.format.name, root: paths.root, pages }, null, 2)}\n`);
      return;
    }
    for (const p of pages) process.stdout.write(`${p.id.padEnd(48)} ${p.type.padEnd(10)} ${p.title}\n`);
  });

program
  .command('show')
  .description('show one page: metadata, body rendered to HTML (links as llmwiki:// URLs), links and backlinks')
  .argument('<page>', 'page id (entities/ada-lovelace), with or without wiki/ and the extension')
  .option('--json', 'machine-readable output: {wiki, format, id, path, abs, title, type, summary, updated, sources, frontmatter, html, links, backlinks, sourceFiles}', false)
  .action(async (page: string, opts: { json: boolean }) => {
    const paths = await openWiki(loadConfig(), 'show');
    const v = viewPage(paths, wikiLabel(paths), page);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${v.title}  (${v.type}, ${v.path})\n${v.summary ? `${v.summary}\n` : ''}\nlinks to: ${v.links.map((l) => l.id).join(', ') || 'none'}\nlinked from: ${v.backlinks.map((l) => l.id).join(', ') || 'none'}\n`);
  });

program
  .command('graph')
  .description('the wiki as a graph: pages (nodes), the links between them, the source files they cite, and broken links')
  .option('--json', 'machine-readable output: {wiki, format, nodes:[{id, title, type, summary, degree}], links:[{from, to}], sources:[{path, exists, pages}], missing:[{from, target}]}', false)
  .action(async (opts: { json: boolean }) => {
    const paths = await openWiki(loadConfig(), 'graph');
    const g = viewGraph(paths, wikiLabel(paths));
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(g, null, 2)}\n`);
      return;
    }
    const orphans = g.nodes.filter((n) => n.degree === 0);
    const hubs = [...g.nodes].sort((a, b) => b.degree - a.degree).slice(0, 10).filter((n) => n.degree > 0);
    process.stdout.write(`${g.nodes.length} pages, ${g.links.length} links, ${g.sources.length} source files, ${g.missing.length} broken links, ${orphans.length} unlinked pages\n`);
    if (hubs.length) process.stdout.write(`\nmost connected:\n${hubs.map((n) => `  ${String(n.degree).padStart(4)}  ${n.id}`).join('\n')}\n`);
    if (orphans.length) process.stdout.write(`\nunlinked:\n${orphans.map((n) => `  ${n.id}`).join('\n')}\n`);
  });

program
  .command('convert')
  .description('convert the selected wiki to another page format (markdown → html); the markdown files are kept in .llm-wiki/backup/')
  .requiredOption('--to <format>', 'target page format: html')
  .option('--dry-run', 'report what would be converted without writing', false)
  .option('--keep-schema', 'leave CLAUDE.md/AGENTS.md untouched (by default their template sections are replaced with the HTML versions and custom sections kept)', false)
  .option('--json', 'machine-readable output: {wiki, from, to, dryRun, pages, logEntries, unresolvedLinks, schema, schemaSectionsReplaced, backup}', false)
  .action(async (opts: { to: string; dryRun: boolean; keepSchema: boolean; json: boolean }) => {
    const target = parseWikiFormat(opts.to, '--to');
    const paths = await openWiki(loadConfig(), 'convert');
    if (target !== 'html') throw new LlmWikiError(`Converting to ${target} is not supported; only markdown → html is.`);
    const r = convertToHtml(paths, { dryRun: opts.dryRun, keepSchema: opts.keepSchema });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ wiki: selectedWikiName, ...r }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${r.dryRun ? 'Would convert' : 'Converted'} ${r.pages.length} page(s) and ${r.logEntries} log entr${r.logEntries === 1 ? 'y' : 'ies'} from markdown to HTML.\n`);
    if (r.unresolvedLinks.length > 0) {
      process.stdout.write(`${r.unresolvedLinks.length} link(s) point at no page and become dashed "missing" links:\n${r.unresolvedLinks.slice(0, 20).map((u) => `  ${u.page} → ${u.target}`).join('\n')}${r.unresolvedLinks.length > 20 ? '\n  …' : ''}\n`);
    }
    const will = r.dryRun ? 'would be' : 'were';
    process.stdout.write(
      r.schema === 'rewritten'
        ? `CLAUDE.md / AGENTS.md ${will} rewritten for HTML pages.\n`
        : r.schema === 'merged'
          ? `CLAUDE.md / AGENTS.md are customised: sections ${will} replaced with their HTML versions (${r.schemaSectionsReplaced.join(', ') || 'none'}); custom sections kept.\n`
          : `CLAUDE.md / AGENTS.md ${will} left untouched (--keep-schema); they still describe markdown pages.\n`,
    );
    if (r.backup) process.stdout.write(`Markdown files moved to ${r.backup}/. Open ${paths.relToRoot(paths.index)} in a browser.\n`);
  });

program
  .command('log')
  .description('show recent log entries')
  .option('--last <n>', 'number of entries', intArg, 10)
  .option('--kind <kind>', 'filter by kind (ingest, query, lint, edit, note, init)')
  .option('--json', 'machine-readable output', false)
  .action(async (opts: { last: number; kind?: string; json: boolean }) => {
    const paths = await openWiki(loadConfig(), 'log');
    const entries = readLog(paths).filter((e) => !opts.kind || e.kind === opts.kind).slice(-opts.last);
    if (opts.json) process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    else process.stdout.write(entries.length === 0 ? 'Log is empty.\n' : `${entries.map((e) => `## [${e.date}] ${e.kind} | ${e.title}${e.body ? `\n${e.body}` : ''}`).join('\n\n')}\n`);
  });

program
  .command('config')
  .description('show which settings are resolved and from which tier')
  .action(() => {
    const config = loadConfig();
    const rows = config.describe((n) => /^(LLM_WIKI_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_OPENAI_|AZURE_AI_INFERENCE_|OLLAMA_|LITELLM_)/.test(n));
    process.stdout.write(`config folder: ${toolConfigDir()} (${fs.existsSync(toolConfigDir()) ? 'present' : 'missing'})\n`);
    process.stdout.write(`resolution: shell env < ~/.tool-agents/llm-wiki/.env < ./.env < CLI flags\n\n`);
    if (rows.length === 0) process.stdout.write('no llm-wiki or provider settings found\n');
    for (const r of rows) process.stdout.write(`${r.name.padEnd(32)} ${r.tier.padEnd(16)} ${r.value}\n`);
    const registry = openRegistry();
    const sel = resolveWiki(config, registry);
    process.stdout.write(`\nregistry: ${registry.file} (${registry.size} wiki(s), current: ${registry.current ?? 'none'})\n`);
    process.stdout.write(`selected wiki: ${sel ? `${sel.name ?? '(unregistered)'} — ${sel.root} (via ${sel.via})` : 'none'}\n`);
  });

program
  .command('mcp')
  .description('serve the registered wikis over MCP stdio; every tool takes an optional `wiki` name (default: the selected wiki)')
  .action(async () => {
    const config = loadConfig();
    const registry = openRegistry();
    const selected = resolveWiki(config, registry);
    if (selected) new WikiPaths(selected.root).assertInitialised();
    info(selected ? `default wiki: ${selected.name ?? '(unregistered)'} — ${selected.root}` : 'no default wiki: every tool call must name one');
    await serveMcp(config, registry.file, selected);
  });

program
  .command('guide')
  .description('print the complete usage guide for people and AI agents (use it to build a Claude skill)')
  .argument('[topic]', `one topic: ${GUIDE_TOPICS.map((t) => t.id).join(', ')}`)
  .option('--topics', 'list the topics and exit', false)
  .option('--json', 'machine-readable guide: topics plus the full command/option tree', false)
  .action((topic: string | undefined, opts: { topics: boolean; json: boolean }) => {
    if (opts.topics) {
      for (const t of GUIDE_TOPICS) process.stdout.write(`${t.id.padEnd(12)} ${t.title}\n`);
      return;
    }
    if (opts.json) {
      const g = guideJson(program, VERSION) as { topics: Array<{ id: string }> };
      const out = topic ? { ...g, topics: g.topics.filter((t) => t.id === parseTopic(topic)) } : g;
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${topic ? renderTopic(program, parseTopic(topic)) : renderGuide(program, VERSION)}\n`);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof LlmWikiError) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(err.exitCode);
  }
  const verbose = program.opts<{ verbose?: boolean }>().verbose === true;
  const msg = err instanceof Error ? (verbose ? (err.stack ?? err.message) : err.message) : String(err);
  process.stderr.write(`error: ${msg}\n${verbose ? '' : '(re-run with --verbose for a stack trace)\n'}`);
  process.exit(1);
});
