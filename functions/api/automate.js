// Cloudflare Pages Function: POST /api/automate
// The "Automation finder" demo on /ai. Keeps the Anthropic key server side.
// Cloudflare: Settings > Variables and Secrets > ANTHROPIC_API_KEY (Secret). Same key as /api/ask.

const SYSTEM =
  "You are the automation architect at NJYN AI, a Toronto firm that helps businesses incorporate AI into daily workflows, " +
  "automate routine processes, and eliminate manual work and errors. A visitor describes a task their team does by hand. " +
  "Design a realistic automation for it. Be practical and conservative: prefer tools a small business already has or can adopt " +
  "(Microsoft 365 and Power Automate, Google Workspace and Apps Script, Zapier or Make, the business's existing CRM, EMR, POS or accounting software and their integrations, " +
  "and an LLM such as Claude for reading, drafting, classifying, or summarizing). Never promise guaranteed results. " +
  "If the task touches patient or client health information, include one short privacy note about consent and Canadian privacy law (PHIPA or PIPEDA) and keeping data in approved systems. " +
  "Respond with ONLY a JSON object, no markdown, in exactly this shape: " +
  '{"title":"short name of the automation, max 6 words",' +
  '"summary":"one sentence on what changes for the team",' +
  '"steps":["3 to 5 short steps describing how the automated workflow runs"],' +
  '"tools":["2 to 5 tool names"],' +
  '"hours_low":number,"hours_high":number,' +
  '"errors_removed":"one sentence naming the specific errors this removes",' +
  '"complexity":"Low" or "Medium" or "High",' +
  '"first_win":"one sentence describing the smallest version that could ship in the first week",' +
  '"privacy_note":"string or empty string"} ' +
  "hours_low and hours_high are a conservative estimate of staff hours saved per week for a typical small team. Keep every string under 220 characters.";

function parsePlan(text) {
  if (!text) return null;
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    const p = JSON.parse(text.slice(s, e + 1));
    if (!p || !Array.isArray(p.steps)) return null;
    return p;
  } catch {
    return null;
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.ANTHROPIC_API_KEY) return json({ error: "API key not configured" }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const task = (body.task || "").toString().trim().slice(0, 600);
  const industry = (body.industry || "").toString().trim().slice(0, 80);
  if (task.length < 8) return json({ error: "Describe the task in a sentence or two" }, 400);

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 900,
      system: SYSTEM,
      messages: [{ role: "user", content: (industry ? `Industry or team: ${industry}\n` : "") + `Manual task: ${task}` }],
    }),
  });

  if (!upstream.ok) return json({ error: "Upstream error", status: upstream.status }, 502);
  const data = await upstream.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const plan = parsePlan(text);
  if (!plan) return json({ error: "Could not build a plan, try rephrasing" }, 502);
  return json({ plan });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
