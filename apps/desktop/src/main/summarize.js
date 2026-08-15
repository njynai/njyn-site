"use strict";

/**
 * Transcript -> structured meeting notes.
 *
 * Asks the model for JSON so the markdown we write is consistently shaped
 * regardless of provider. If the model returns something unparseable we keep
 * its prose rather than losing the work.
 */

const PROMPT = `You are a meeting scribe. You are given a raw, unedited transcript of a meeting. It comes from automatic speech recognition, so expect misheard words, missing punctuation, and no reliable speaker labels.

Produce notes for someone who did not attend.

Return ONLY a JSON object, no code fences and no commentary, with exactly this shape:

{
  "title": "short descriptive title for the meeting, max 8 words",
  "summary": ["exactly 5 bullets"],
  "decisions": ["each decision that was actually settled"],
  "actions": [{"task": "what must be done", "owner": "who owns it", "due": "when, or empty string"}]
}

Rules:
- "summary" must contain exactly 5 bullets. Each is one sentence covering what was discussed and why it mattered. Do not pad with filler; if the meeting was short, make the bullets narrower rather than inventing content.
- "decisions" lists only things that were settled. If something was debated and left open, it is not a decision. Return an empty array if nothing was decided.
- "actions" lists concrete commitments. Set "owner" to the name used in the transcript. If no owner was named, use "Unassigned" - never guess a person. Set "due" to "" if no date was mentioned.
- Never invent names, numbers, dates, or commitments that are not in the transcript. If the transcript is too garbled or too short to support a field, return an empty array for it.
- Write in plain, direct language. No preamble.`;

/* ------------------------------------------------------------- providers */

async function callAnthropic(config, transcript) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.keys.anthropic,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.llmModel,
      max_tokens: 2000,
      system: PROMPT,
      messages: [{ role: "user", content: `<transcript>\n${transcript}\n</transcript>` }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic request failed (HTTP ${res.status}): ${(await res.text()).slice(0, 400)}`);
  }
  const json = await res.json();
  return (json.content || []).map((block) => block.text || "").join("").trim();
}

async function callOpenAICompatible(config, transcript, { url, key }) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: config.llmModel,
      max_tokens: 2000,
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: `<transcript>\n${transcript}\n</transcript>` },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM request failed (HTTP ${res.status}): ${(await res.text()).slice(0, 400)}`);
  }
  const json = await res.json();
  return (json.choices?.[0]?.message?.content || "").trim();
}

/* ------------------------------------------------------------ formatting */

/** Pull a JSON object out of a response that may be wrapped in prose or fences. */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function bullet(list, emptyText) {
  if (!Array.isArray(list) || list.length === 0) return `_${emptyText}_`;
  return list.map((item) => `- ${String(item).trim()}`).join("\n");
}

function renderActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return "_No action items were assigned._";
  }
  return actions
    .map((a) => {
      const owner = String(a?.owner || "Unassigned").trim() || "Unassigned";
      const task = String(a?.task || "").trim();
      const due = String(a?.due || "").trim();
      return `- **${owner}** — ${task}${due ? ` _(due ${due})_` : ""}`;
    })
    .join("\n");
}

/** Turn the parsed JSON into the markdown body of the note. */
function renderNotes(parsed) {
  const summary = Array.isArray(parsed.summary) ? parsed.summary.slice(0, 5) : [];
  return [
    "## Summary",
    bullet(summary, "No summary could be produced from this transcript."),
    "",
    "## Decisions",
    bullet(parsed.decisions, "No decisions were recorded."),
    "",
    "## Action items",
    renderActions(parsed.actions),
  ].join("\n");
}

/* ----------------------------------------------------------------- entry */

/**
 * @returns {Promise<{title: string|null, markdown: string, model: string}>}
 */
async function summarize(config, transcript) {
  if (!config.llmProvider) {
    throw new Error(
      "No LLM key found. Add ANTHROPIC_API_KEY, OPENAI_API_KEY or GROQ_API_KEY to .env " +
        "to get summaries. The transcript is saved either way.",
    );
  }

  let raw;
  if (config.llmProvider === "anthropic") {
    raw = await callAnthropic(config, transcript);
  } else if (config.llmProvider === "openai") {
    raw = await callOpenAICompatible(config, transcript, {
      url: "https://api.openai.com/v1/chat/completions",
      key: config.keys.openai,
    });
  } else {
    raw = await callOpenAICompatible(config, transcript, {
      url: "https://api.groq.com/openai/v1/chat/completions",
      key: config.keys.groq,
    });
  }

  const parsed = extractJson(raw);
  if (!parsed) {
    // Model went off-script. Keep what it said rather than throwing the work away.
    return {
      title: null,
      markdown: `## Summary\n\n${raw}`,
      model: `${config.llmProvider}/${config.llmModel}`,
    };
  }

  return {
    title: parsed.title ? String(parsed.title).trim() : null,
    markdown: renderNotes(parsed),
    model: `${config.llmProvider}/${config.llmModel}`,
  };
}

module.exports = { summarize, renderNotes, extractJson, PROMPT };
