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

export function startDemoServer(port = 4173) {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const urlPath = (req.url ?? '/').split('?')[0];
      const filePath = path.join(__dirname, urlPath === '/' ? 'index.html' : urlPath);
      if (!filePath.startsWith(__dirname)) {
        res.writeHead(403).end();
        return;
      }
      try {
        const file = await stat(filePath);
        if (!file.isFile()) {
          res.writeHead(404).end('Not found');
          return;
        }
      } catch {
        res.writeHead(404).end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      const stream = createReadStream(filePath);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });

    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        server,
        url: `http://127.0.0.1:${actualPort}/`,
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((error) => error ? closeReject(error) : closeResolve());
        }),
      });
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.argv[2] ?? 4173);
  const demo = await startDemoServer(port);
  console.log(`Acme Admin demo running at ${demo.url}`);
  console.log(`Try: redpen open ${demo.url}`);
}
