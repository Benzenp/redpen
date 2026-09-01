#!/usr/bin/env node
// Zero-dependency static server for fixtures/demo-app/index.html so it can
// be opened as a real http://127.0.0.1 target for `redpen open`. Not part
// of the automated test suite — this is the manual "날먹" demo page.
//
// Usage: node fixtures/demo-app/serve.mjs [port]
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 4173);

const server = createServer(async (req, res) => {
  const urlPath = (req.url ?? '/').split('?')[0];
  const filePath = path.join(__dirname, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403).end();
    return;
  }
  try {
    await stat(filePath);
  } catch {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  createReadStream(filePath).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Acme Admin demo running at http://127.0.0.1:${port}/`);
  console.log(`Try: redpen open http://127.0.0.1:${port}/`);
});
