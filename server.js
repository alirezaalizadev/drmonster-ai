// Minimal, dependency-free production server for the DrMonster AI app.
// The app is a single static index.html (no build framework). This server:
//   - listens on the port Railway provides (process.env.PORT)
//   - serves index.html, injecting the PUBLIC Supabase config from env vars
//     (SUPABASE_URL + SUPABASE_ANON_KEY — the anon key is browser-safe / RLS-protected)
//   - serves other static assets, with a health check at /healthz
//
// No secret keys are ever injected here. The Anthropic key lives only in the
// Supabase Edge Functions, never in the browser or this server.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function configScript() {
  const cfg = {
    url: process.env.SUPABASE_URL || "",
    anonKey: process.env.SUPABASE_ANON_KEY || "",
  };
  return "<script>window.__DRM_CONFIG__=" + JSON.stringify(cfg) + ";</script>";
}

function serveIndex(res) {
  let html;
  try {
    html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("index.html not found");
    return;
  }
  const inject = configScript();
  html = html.includes("</head>") ? html.replace("</head>", inject + "</head>") : inject + html;
  res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
  res.end(html);
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  if (urlPath === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  if (urlPath === "/" || urlPath === "/index.html") {
    serveIndex(res);
    return;
  }

  // Static asset lookup, protected against path traversal.
  const safe = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(ROOT, safe);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("forbidden");
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      serveIndex(res); // single-page fallback
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log("DrMonster AI listening on port " + PORT);
});
