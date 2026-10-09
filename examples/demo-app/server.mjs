// The aipw demo app (docs/02 §6): a small static site with the hard UI patterns aipw must handle, and
// switchable UI variants (?variant=b) so healing can be tested against changes we control.
// No dependencies: node examples/demo-app/server.mjs  (PORT defaults to 5173)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const routes = { '/': 'login.html', '/login': 'login.html', '/app': 'app.html', '/users': 'users.html' };
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const file = routes[pathname] ?? normalize(pathname).replace(/^[/\\]+/, '');
  if (file.includes('..')) {
    res.writeHead(400).end();
    return;
  }
  try {
    const body = await readFile(join(root, file));
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
});

const port = Number(process.env.PORT ?? 5173);
server.listen(port, () => console.log(`aipw demo app on http://localhost:${port}`));
