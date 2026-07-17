#!/usr/bin/env node
// Lovable sandbox placeholder build. The real app is a Next.js project deployed to VPS.
const fs = require("fs");
const path = require("path");
const out = path.join(__dirname, "dist");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(
  path.join(out, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"><title>P4 Polymarket Bot</title></head><body><h1>P4 Polymarket Bot</h1><p>Next.js source repository. Run <code>pnpm build && pnpm start</code> on your VPS.</p></body></html>`
);
console.log("dist/index.html written");
