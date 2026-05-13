// Cloudflare Worker that responds with "Hello, World!"
// Deploy with: wrangler deploy

export default {
  async fetch(request, env, ctx) {
    return new Response("Hello, World!", {
      status: 200,
      headers: {
        "Content-Type": "text/plain",
        "X-Worker-Location": "Cloudflare"
      }
    });
  }
};
