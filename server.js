// Minimal static file server for GoDaddy Node.js Hosting (no dependencies).
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
};

// Files that must never be served.
const BLOCKED = new Set(["server.js", "package.json", "package-lock.json", ".env"]);

http
  .createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    } catch {
      res.writeHead(400).end("Bad request");
      return;
    }
    if (urlPath === "/" || urlPath === "") urlPath = "/index.html";

    const filePath = path.normalize(path.join(ROOT, urlPath));
    const rel = path.relative(ROOT, filePath);
    if (rel.startsWith("..") || path.isAbsolute(rel) || rel.split(path.sep).some((p) => p.startsWith(".")) || BLOCKED.has(rel)) {
      res.writeHead(404).end("Not found");
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        // Unknown paths fall back to the home page.
        fs.readFile(path.join(ROOT, "index.html"), (e2, home) => {
          if (e2) return res.writeHead(500).end("Server error");
          res.writeHead(200, { "Content-Type": TYPES[".html"] }).end(home);
        });
        return;
      }
      const type = TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": type }).end(data);
    });
  })
  .listen(PORT, HOST, () => {
    console.log(`Serenity Place site running on http://${HOST}:${PORT}`);
  });
