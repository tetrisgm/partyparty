// party.ramine.net
//
// The Sparkle feed and the app zips (both the stable "latest" alias and the
// immutable versioned files the feed points at) come from R2 so we're not bound
// by the static-assets file-size cap. Everything else — the landing page — is
// served straight from the ../site static assets.
//
//   GET /appcast.xml            -> R2 (Sparkle update feed)
//   GET /partyparty.zip         -> R2 (latest build, for the download button)
//   GET /partyparty-<ver>.zip   -> R2 (immutable, Sparkle enclosures)
//   GET /*                      -> static landing page

const ZIP_RE = /^\/[A-Za-z0-9._-]+\.zip$/; // single path segment, no traversal

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const isFeed = pathname === "/appcast.xml";
    const isZip = ZIP_RE.test(pathname);

    if (isFeed || isZip) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const key = pathname.slice(1);
      const obj = await env.DL.get(key);
      if (!obj) return new Response("Not found — run `make release`.", { status: 404 });

      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);
      if (isFeed) {
        headers.set("content-type", "application/xml");
        headers.set("cache-control", "public, max-age=60");
      } else {
        headers.set("content-type", "application/zip");
        headers.set("content-disposition", `attachment; filename="${key}"`);
        // "latest" alias refreshes each release; versioned files are immutable.
        headers.set("cache-control", key === "partyparty.zip" ? "public, max-age=300" : "public, max-age=86400, immutable");
      }
      return new Response(request.method === "HEAD" ? null : obj.body, { headers });
    }

    return env.ASSETS.fetch(request);
  },
};
