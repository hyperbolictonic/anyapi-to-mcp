// Build the GitHub Pages site into `_site`.
//
// The landing page lives in `site/` and is copied as-is (HTML plus its
// Markdown alternate). Everything else is generated from the repository's own
// Markdown, so the published pages cannot drift from the README or the design
// notes. Each generated page ships next to its `.md` source and advertises it
// with `rel="alternate" type="text/markdown"`, the same convention as the
// Hypagon site.

import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';

const root = process.cwd();
const out = path.join(root, '_site');
const repoUrl = 'https://github.com/hyperbolictonic/anyapi-to-mcp';
const pagesRoot = 'https://hyperbolictonic.github.io/anyapi-to-mcp';

const pageDocs = [
  ['README.md', 'README.html', 'Overview'],
  ['docs/DESIGN.md', 'docs/DESIGN.html', 'Design notes'],
  ['AGENTS.md', 'AGENTS.html', 'Working rules'],
  ['examples/README.md', 'examples/README.html', 'Examples'],
];

function frontmatterOf(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { body: markdown, title: null };
  const titleMatch = match[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
  return { body: markdown.slice(match[0].length), title: titleMatch ? titleMatch[1].trim() : null };
}

function titleOf(markdown, fallback) {
  const parsed = frontmatterOf(markdown);
  if (parsed.title) return parsed.title;
  const match = parsed.body.match(/^#\s+(.+)$/m);
  return match ? match[1].replace(/[*_`]/g, '').trim() : fallback;
}

function prefixFor(output) {
  return '../'.repeat(output.split('/').length - 1);
}

const pageInfo = new Map();
for (const [file, output, label] of pageDocs) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) continue;
  const markdown = fs.readFileSync(full, 'utf8');
  const parsed = frontmatterOf(markdown);
  pageInfo.set(file, {
    file,
    output,
    label,
    title: parsed.title || titleOf(markdown, path.basename(file, '.md')),
    markdown: parsed.body,
  });
}

const sourceToPage = new Map([...pageInfo.values()].map((page) => [page.file, page]));

// Headings need GitHub-style ids: the generated pages cross-link to sections
// (`README.html#pins`), and a bare `<h2>` would make those links inert.
let currentIds = new Map();
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}
marked.use({
  renderer: {
    heading(token) {
      const html = this.parser.parseInline(token.tokens);
      const base = slugify(html);
      const count = currentIds.get(base) ?? 0;
      currentIds.set(base, count + 1);
      const id = count === 0 ? base : `${base}-${count}`;
      return `<h${token.depth} id="${id}">${html}</h${token.depth}>\n`;
    },
  },
});

const docsCss = `:root{--bg:#0b1220;--panel:#111a2b;--line:#243653;--text:#e6edf7;--muted:#9aabc2;--cyan:#22d3ee;--green:#a3e635;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 8% -10%,rgba(34,211,238,.14),transparent 30rem),var(--bg);color:var(--text);line-height:1.65}a{color:var(--cyan);text-decoration:none}a:hover{text-decoration:underline}.topbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:66px;padding:0 24px;border-bottom:1px solid var(--line);background:rgba(11,18,32,.9);backdrop-filter:blur(14px)}.brand{display:flex;align-items:center;gap:10px;color:var(--text);font-weight:800;letter-spacing:.02em;font-size:13px}.brand:hover{text-decoration:none}.mark{display:grid;place-items:center;width:30px;height:30px;border:1px solid var(--line);border-radius:9px;background:var(--panel);color:var(--green);font:800 11px/1 ui-monospace,Consolas,monospace}.topnav{display:flex;gap:18px;flex-wrap:wrap;font-size:12px}.topnav a{color:var(--muted)}.shell{display:grid;grid-template-columns:220px minmax(0,1fr);gap:36px;max-width:1080px;margin:0 auto;padding:28px 24px 60px}.sidebar{position:sticky;top:90px;align-self:start;border-right:1px solid var(--line);padding-right:18px}.side-title{margin:0 0 8px;color:var(--green);font:700 10px/1.4 ui-monospace,Consolas,monospace;text-transform:uppercase;letter-spacing:.12em}.sidebar a{display:block;padding:4px 0;color:var(--muted);font-size:12.5px}.sidebar a.active,.sidebar a:hover{color:var(--cyan)}.content{min-width:0;max-width:820px}.source-link{display:flex;justify-content:flex-end;gap:14px;margin-bottom:16px;font-size:11px;color:var(--muted)}h1,h2,h3,h4{line-height:1.22;letter-spacing:-.025em;scroll-margin-top:90px}h1{font-size:clamp(2rem,5vw,3.2rem);margin:.2em 0 .55em}h2{font-size:1.6rem;margin-top:2em;padding-top:.3em;border-top:1px solid var(--line)}h3{font-size:1.15rem;margin-top:1.6em}code{font-family:ui-monospace,Consolas,"SF Mono",monospace;font-size:.9em;background:#0d1728;border:1px solid var(--line);border-radius:5px;padding:1px 5px}pre{overflow:auto;padding:16px;border:1px solid var(--line);border-radius:12px;background:#0c1524}pre code{border:0;background:none;padding:0}blockquote{margin:1.4em 0;padding:10px 16px;border-left:2px solid var(--green);background:rgba(163,230,53,.06);color:var(--muted)}table{border-collapse:collapse;width:100%;margin:1.2em 0;font-size:13px}th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}th{background:#0d1728}img{max-width:100%}hr{border:0;border-top:1px solid var(--line);margin:2em 0}.page-footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}@media(max-width:820px){.shell{grid-template-columns:1fr}.sidebar{position:static;border-right:0;border-bottom:1px solid var(--line);padding:0 0 14px}}`;

function layout(page, body) {
  const prefix = prefixFor(page.output);
  const rawRel = page.file;
  const rawHref = path.posix.relative(path.posix.dirname(page.output) === '.' ? '' : path.posix.dirname(page.output), rawRel) || rawRel;
  const nav = [
    ['Home', `${prefix}index.html`],
    ['Overview', `${prefix}README.html`],
    ['Design', `${prefix}docs/DESIGN.html`],
    ['Agents', `${prefix}AGENTS.html`],
    ['Examples', `${prefix}examples/README.html`],
    ['GitHub', repoUrl],
  ];
  const sidebar = [...pageInfo.values()];
  const title = page.title.includes('Any API') ? page.title : `${page.title} — Any API → MCP`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark light" />
  <title>${title}</title>
  <link rel="alternate" type="text/markdown" href="${rawHref}" />
  <link rel="stylesheet" href="${prefix}assets/docs.css" />
</head>
<body>
  <header class="topbar">
    <a class="brand" href="${prefix}index.html"><span class="mark">A→M</span><span>Any API → MCP</span></a>
    <nav class="topnav">${nav.map(([label, href]) => `<a href="${href}">${label}</a>`).join('')}</nav>
  </header>
  <div class="shell">
    <aside class="sidebar">
      <div class="side-title">Pages</div>
      <a class="${page.output === 'README.html' ? 'active' : ''}" href="${prefix}README.html">Overview</a>
      ${sidebar.filter((item) => item.output !== 'README.html').map((item) => `<a class="${item.output === page.output ? 'active' : ''}" href="${prefix}${item.output}">${item.label}</a>`).join('')}
      <div class="side-title" style="margin-top:18px">Meta</div>
      <a href="${prefix}index.md">Landing (Markdown)</a>
      <a href="${pagesRoot}/">Project site</a>
      <a href="https://hyperbolictonic.github.io/">HyperbolicTonic</a>
    </aside>
    <main class="content">
      <div class="source-link"><a href="${rawHref}">Markdown</a><a href="${repoUrl}/blob/main/${rawRel}">View source on GitHub</a></div>
      ${body}
      <footer class="page-footer"><a href="${prefix}index.html">Home</a> · <a href="${prefix}README.html">Overview</a> · <a href="${repoUrl}">GitHub</a></footer>
    </main>
  </div>
</body>
</html>`;
}

function rewriteLinks(html, page) {
  const sourceDir = path.dirname(page.file);
  return html.replace(/href="(?!https?:|mailto:|#)([^"]+)"/g, (match, href) => {
    const [pathname, hash = ''] = String(href).split('#');
    const targetFile = pathname.startsWith('/')
      ? path.join(root, pathname.slice(1))
      : path.resolve(sourceDir, pathname);
    const relative = path.relative(root, targetFile).split(path.sep).join('/');
    const target = sourceToPage.get(relative);

    if (pathname.endsWith('.md')) {
      if (target) {
        const outRel = path.posix.relative(path.posix.dirname(page.output), target.output);
        return `href="${outRel}${hash ? `#${hash}` : ''}"`;
      }
      return `href="${repoUrl}/blob/main/${relative}${hash ? `#${hash}` : ''}"`;
    }

    if (/(\.json|\.mjs|\.cjs|\.js|\.ts|\.yml|\.yaml|\.toml)$/.test(pathname) && fs.existsSync(targetFile)) {
      return `href="${repoUrl}/blob/main/${relative}${hash ? `#${hash}` : ''}"`;
    }

    return match;
  });
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

fs.cpSync(path.join(root, 'site'), out, { recursive: true });
if (fs.existsSync(path.join(root, 'LICENSE'))) fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
fs.writeFileSync(path.join(out, 'assets', 'docs.css'), docsCss);

for (const page of pageInfo.values()) {
  const rawTarget = path.join(out, page.file);
  fs.mkdirSync(path.dirname(rawTarget), { recursive: true });
  fs.copyFileSync(path.join(root, page.file), rawTarget);

  currentIds = new Map();
  const html = rewriteLinks(marked.parse(page.markdown, { gfm: true, breaks: false }), page);
  const target = path.join(out, page.output);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, layout(page, html));
}

const pages = ['', 'README.html', 'docs/DESIGN.html', 'AGENTS.html', 'examples/README.html'];
fs.writeFileSync(
  path.join(out, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((item) => `  <url><loc>${pagesRoot}/${item}</loc><changefreq>weekly</changefreq></url>`).join('\n')}
</urlset>
`,
);
fs.writeFileSync(path.join(out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${pagesRoot}/sitemap.xml\n`);

console.log(`built ${pageInfo.size} Markdown pages plus the landing page into ${path.relative(root, out)}`);
