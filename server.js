const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function safePathname(urlPath) {
  const normalized = path.normalize(urlPath).replace(/^(\.\.[\\/])+/, '');
  return normalized === path.sep ? 'index.html' : normalized.replace(/^[/\\]/, '') || 'index.html';
}

function send(res, statusCode, body, contentType) {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(ROOT, safePathname(pathname));

  if (!filePath.startsWith(ROOT)) {
    send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (pathname !== '/index.html') {
        fs.readFile(path.join(ROOT, 'index.html'), (indexErr, indexData) => {
          if (indexErr) {
            send(res, 404, 'Not found', 'text/plain; charset=utf-8');
            return;
          }
          send(res, 200, indexData, MIME_TYPES['.html']);
        });
        return;
      }
      send(res, 404, 'Not found', 'text/plain; charset=utf-8');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, data, MIME_TYPES[ext] || 'application/octet-stream');
  });
}).listen(PORT, () => {
  console.log(`Battleship Bluff dev server running at http://localhost:${PORT}`);
});
