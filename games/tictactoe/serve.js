// serve.js — minimaler Static-File-Server für TicTacToe
// Verwendung: node serve.js [PORT]
// Lauscht auf 0.0.0.0 → auch von anderen Geräten im Netzwerk erreichbar.
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2] || '3001', 10);
const HTML = path.join(__dirname, 'index.html');

http.createServer((req, res) => {
  fs.readFile(HTML, (err, data) => {
    if (err) { res.writeHead(500); res.end(err.message); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`TicTacToe auf http://0.0.0.0:${PORT}`);
});
