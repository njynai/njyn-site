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
        "Keep the whole answer under 180 words. Plain text only, no markdown formatting.",
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

  return json({ text });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
