import {readFile} from 'node:fs/promises';

// The app's own stylesheets as index.html links them, joined in that order, so
// a test can look for a rule without knowing which file it landed in.
export async function readStyles() {
  const html = await readFile('web/index.html', 'utf8');
  const hrefs = [...html.matchAll(/href="\.\/(styles\/[a-z-]+\.css)"/g)].map(match => match[1]);
  if (!hrefs.length) throw new Error('index.html links no stylesheets from web/styles/');
  return (await Promise.all(hrefs.map(href => readFile(`web/${href}`, 'utf8')))).join('\n');
}
