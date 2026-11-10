// Cloudflare Pages Function — POST /api/ask
// Keeps the Anthropic API key server-side. The static site calls this endpoint.
//
// Setup (Cloudflare dashboard > your Pages project > Settings > Variables):
//   ANTHROPIC_API_KEY = sk-ant-...   (add as a Secret)
//
// Notes:
// - Web search is enabled so demo answers reflect the live web, not training data.
// - Basic abuse controls: prompt length cap, token cap, method check.
//   For a public production endpoint, add Cloudflare Turnstile and a WAF
//   rate-limiting rule (Security > WAF > Rate limiting) on /api/ask.

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "API key not configured" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const prompt = (body.prompt || "").toString().trim().slice(0, 300);
  const business = (body.business || "").toString().trim().slice(0, 120);
  if (!prompt) {
    return json({ error: "Empty prompt" }, 400);
  }

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 700,
      system:
        "You are a consumer AI assistant being asked for a recommendation. " +
        "Answer the question directly and name specific businesses or providers with a one-line reason each, " +
        "the way an AI assistant would for a real consumer. Use web search to ground your answer. " +
        "Keep the answer under 180 words. Plain text only, no markdown formatting. " +
        "After the answer, output exactly one final line in this format and nothing after it: " +
        'RECOMMENDED: ["Business Name 1","Business Name 2"] ' +
        "listing every specific business or provider you recommended, in order.",
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    }),
  });

  if (!upstream.ok) {
    return json({ error: "Upstream error", status: upstream.status }, 502);
  }

  const data = await upstream.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  // Split the structured trailer from the prose answer
  let answer = text;
  let recommended = [];
  const m = text.match(/RECOMMENDED:\s*(\[[\s\S]*\])\s*$/);
  if (m) {
    try { recommended = JSON.parse(m[1]); } catch {}
    answer = text.slice(0, m.index).trim();
  }
  let inAnswer = null;
  if (business) {
    const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
    const b = norm(business);
    inAnswer =
      recommended.some((r) => norm(String(r)).includes(b) || b.includes(norm(String(r)))) ||
      norm(answer).includes(b);
  }
  return json({ text: answer, recommended, inAnswer });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
