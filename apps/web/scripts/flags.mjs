/**
 * The flag artwork, copied out of the library and into what we serve.
 *
 * `country-flag-icons` (MIT; the flags themselves are public-domain drawings
 * from Wikimedia) ships one SVG per ISO 3166-1 country. We do not import them
 * into the bundle: 267 flags is 1.3 MB, and a household looking at Italy should
 * not download Bhutan's. They are copied beside the other static files instead,
 * so the browser fetches exactly the flags a screen draws, from our own origin,
 * and the service worker can keep them.
 *
 * Runs before `expo start --web` and before `expo export`, so the folder exists
 * in development and in the deployed build. `public/flags` is git-ignored: the
 * library is the source, this script is how it gets there. Nothing breaks if it
 * has not run — `Flag.tsx` falls back to the country code.
 */
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, '..', '..', '..', 'node_modules', 'country-flag-icons', '3x2');
const to = join(here, '..', 'public', 'flags');

let files;
try {
  files = readdirSync(from).filter((f) => f.endsWith('.svg'));
} catch {
  console.warn('flags: country-flag-icons is not installed — country rows will show the two-letter code.');
  process.exit(0);
}

rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
for (const f of files) cpSync(join(from, f), join(to, f));
console.log(`flags: ${files.length} flags → apps/web/public/flags`);
