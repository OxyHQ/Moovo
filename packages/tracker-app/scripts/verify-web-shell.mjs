/**
 * Assert that the EXPORTED web shell is what we meant to serve.
 *
 * `public/index.html` is Expo's web-shell template for `web.output: "single"`,
 * and every injection into it is a `String.replace` with a STRING pattern —
 * first occurrence only. Four targets: `%LANG_ISO_CODE%`, `%WEB_TITLE%`,
 * `</head>` (description, theme colour, CSS links, favicon) and `</body>` (the
 * bundle scripts). A template that mentions one of them in passing CONSUMES that
 * injection, and both failure modes ship silently:
 *
 * - a swallowed `%WEB_TITLE%` serves the raw placeholder as the page title;
 * - a swallowed `</head>` loses the Tailwind stylesheet — the app still BOOTS,
 *   because scripts go before `</body>`, and renders every screen unstyled
 *   (`bg-background` transparent, `text-foreground` black on Bloom's dark
 *   ground), which is indistinguishable from "the UI does not load".
 *
 * Neither breaks the build. So the build is made to break here.
 *
 * Comments are STRIPPED before the markup assertions, because the whole failure
 * is content that is present in the file and inert in the browser: asserting on
 * the raw text would pass on exactly the broken output this exists to catch.
 */

import fs from 'node:fs';
import path from 'node:path';

const dist = process.argv[2] ?? path.join(import.meta.dirname, '..', 'dist');
const file = path.join(dist, 'index.html');

if (!fs.existsSync(file)) {
  console.error(`verify-web-shell: no ${file} — run the export first`);
  process.exit(1);
}

const raw = fs.readFileSync(file, 'utf8');
const markup = raw.replace(/<!--[\s\S]*?-->/g, '');

const checks = [
  ['the Spanish <title> (%WEB_TITLE% substituted)', () => /<title>Rastrear paquete[^<]*<\/title>/.test(markup)],
  ['lang="es" (%LANG_ISO_CODE% substituted)', () => /<html lang="es"/.test(markup)],
  ['a stylesheet <link> as real markup', () => /rel="stylesheet"/.test(markup)],
  ['the bundle <script> tags as real markup', () => /<script src="\/_expo\//.test(markup)],
  ['a description meta', () => /<meta name="description"/.test(markup)],
];

const failed = checks.filter(([, test]) => !test()).map(([what]) => what);

if (failed.length > 0) {
  console.error('verify-web-shell: the exported shell is missing:');
  for (const what of failed) console.error(`  - ${what}`);
  console.error(
    '\nMost likely cause: something in packages/tracker-app/public/index.html\n' +
      'contains one of %LANG_ISO_CODE%, %WEB_TITLE%, </head> or </body> before the\n' +
      'place that should receive it, so Expo injected into that instead.',
  );
  process.exit(1);
}

console.log('verify-web-shell: title, lang, stylesheet, scripts and description all present as markup');
