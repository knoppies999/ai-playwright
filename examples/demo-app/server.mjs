// The aipw demo app (docs/02 §6): a small static site with the hard UI patterns aipw must handle, and
// switchable UI variants (?variant=b) so healing can be tested against changes we control.
// No dependencies: node examples/demo-app/server.mjs  (PORT defaults to 5173)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const routes = {
  '/': 'login.html',
  '/login': 'login.html',
  '/app': 'app.html',
  '/users': 'users.html',
  '/users/new': 'users-new.html',
};
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

// --- Server-side validation for POST /api/users: the form only passes with real, valid values ---------

function luhnOk(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

function saIdOk(id) {
  if (!/^\d{13}$/.test(id) || !luhnOk(id)) return false;
  const mm = Number(id.slice(2, 4));
  const dd = Number(id.slice(4, 6));
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && (id[10] === '0' || id[10] === '1');
}

function ibanOk(value) {
  const iban = String(value).replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(iban)) return false;
  const numeric = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of numeric) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

function validateUser(u) {
  const errors = {};
  if (!u.firstName?.trim()) errors.firstName = 'required';
  if (!u.lastName?.trim()) errors.lastName = 'required';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u.email ?? '')) errors.email = 'not a valid email address';
  if (!saIdOk(u.idNumber ?? '')) errors.idNumber = 'not a valid South African ID number';
  if (!/^\+27[6-8]\d{8}$/.test(u.phone ?? '')) errors.phone = 'must be a South African mobile number in +27 format';
  if (!ibanOk(u.iban ?? '')) errors.iban = 'not a valid IBAN';
  if ((u.password ?? '').length < 8) errors.password = 'must be at least 8 characters';
  return errors;
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || '{}');
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname === '/api/users' && req.method === 'POST') {
    const user = await readJson(req).catch(() => ({}));
    const errors = validateUser(user);
    const ok = Object.keys(errors).length === 0;
    res.writeHead(ok ? 201 : 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { id: Date.now(), firstName: user.firstName, lastName: user.lastName } : { errors }));
    return;
  }
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
