// serve.js — minimaler Static-File-Server für TicTacToe
// Verwendung: node serve.js [PORT]
// Lauscht auf 0.0.0.0 → auch von anderen Geräten im Netzwerk erreichbar.
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = parseInt(process.argv[2] || '3001', 10);
const GAME_ROOT = __dirname;
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_PUBLIC = path.join(PROJECT_ROOT, 'server', 'public');
const DOCS_ROOT = path.join(PROJECT_ROOT, 'docs');
const SOCKET_IO_CLIENT = path.join(PROJECT_ROOT, 'node_modules', 'socket.io', 'client-dist');

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function inside(baseDir, candidatePath) {
  const rel = path.relative(baseDir, candidatePath);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveFromBase(baseDir, rawPath) {
  const normalized = path.normalize(rawPath).replace(/^([\\/])+/, '');
  const fullPath = path.join(baseDir, normalized);
  if (!inside(baseDir, fullPath)) return null;
  return fullPath;
}

function resolvePath(requestUrl) {
  const url = new URL(requestUrl, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === '/') {
    return path.join(GAME_ROOT, 'index.html');
  }

  if (pathname.startsWith('/tictactoe/')) {
    const mapped = resolveFromBase(GAME_ROOT, pathname.replace('/tictactoe/', ''));
    if (mapped) return mapped;
  }

  if (pathname.startsWith('/assets/')) {
    const assetRelative = pathname.replace('/assets/', '');
    const fromServerPublic = resolveFromBase(SERVER_PUBLIC, assetRelative);
    if (fromServerPublic && fs.existsSync(fromServerPublic)) return fromServerPublic;
    const fromSocketIo = resolveFromBase(SOCKET_IO_CLIENT, assetRelative);
    if (fromSocketIo && fs.existsSync(fromSocketIo)) return fromSocketIo;
  }

  if (pathname.startsWith('/docs/')) {
    const mapped = resolveFromBase(DOCS_ROOT, pathname.replace('/docs/', ''));
    if (mapped) return mapped;
  }

  const fallback = resolveFromBase(GAME_ROOT, pathname);
  return fallback;
}

http.createServer((req, res) => {
  const fullPath = resolvePath(req.url || '/');
  if (!fullPath) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      const status = err.code === 'ENOENT' ? 404 : 500;
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(status === 404 ? 'Not Found' : err.message);
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    const contentType = contentTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`TicTacToe auf http://0.0.0.0:${PORT}`);
});
