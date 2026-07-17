const port = Number(process.env.PORT) || 8080;
Bun.serve({
  port,
  fetch() {
    return new Response(
      "P4 Polymarket bot source. This is a Next.js app — run locally with `pnpm install && pnpm dev`. Lovable sandbox cannot execute it.",
      { headers: { "content-type": "text/plain" } },
    );
  },
});
console.log(`serving on ${port}`);
