// party.ramine.net
//
// Two big files (the app download + the Sparkle appcast) come from R2 so we're
// not bound by the static-assets file-size cap. Everything else — the landing
// page — is served straight from the ../site static assets.
//
//   GET /partyparty.zip -> R2 object (the notarized .app, zipped)
//   GET /appcast.xml    -> R2 object (Sparkle update feed)
//   GET /*              -> static landing page

const R2_FILES = {
  "/partyparty.zip": { key: "partyparty.zip", type: "application/zip", download: "partyparty.zip" },
  "/appcast.xml":    { key: "appcast.xml",    type: "application/xml" },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const spec = R2_FILES[url.pathname];

    if (spec) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const obj = await env.DL.get(spec.key);
      if (!obj) return new Response("Not found yet — run `make deploy-site`.", { status: 404 });

      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);
      headers.set("content-type", spec.type);
      // App zip is immutable-ish; appcast should refresh promptly.
      headers.set("cache-control", spec.download ? "public, max-age=300" : "public, max-age=60");
      if (spec.download) headers.set("content-disposition", `attachment; filename="${spec.download}"`);

      return new Response(request.method === "HEAD" ? null : obj.body, { headers });
    }

    // Landing page + any other static asset.
    return env.ASSETS.fetch(request);
  },
};
