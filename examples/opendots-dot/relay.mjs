#!/usr/bin/env node
// Follows one meeting over AG-UI and relays it to a Slack channel: a line for every new decision
// and action item while the meeting runs, and the minutes when it ends.
//
// No dependencies: Node 22+ only. Environment:
//   OM_URL             Open Meetings server, e.g. http://localhost:4319
//   OM_TOKEN           server token, when it has one
//   SLACK_WEBHOOK_URL  Slack incoming webhook
//   MEETING_URL        a Meet link to join, or
//   MEETING_ID         an existing meeting to follow
//
// Usage: MEETING_URL=https://meet.google.com/abc-defg-hij node relay.mjs

const base = (process.env.OM_URL ?? "http://localhost:4319").replace(/\/$/, "");
const headers = {
  "content-type": "application/json",
  accept: "text/event-stream",
  ...(process.env.OM_TOKEN ? { authorization: `Bearer ${process.env.OM_TOKEN}` } : {}),
};

async function slack(text) {
  if (!process.env.SLACK_WEBHOOK_URL) return console.log(text);
  await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

/** Minimal RFC 6902 for the operations Open Meetings emits on lists and fields. */
function applyPatch(doc, patch) {
  const next = structuredClone(doc);
  for (const op of patch) {
    const keys = op.path
      .split("/")
      .slice(1)
      .map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
    const last = keys.pop();
    const parent = keys.reduce((node, key) => node[key], next);
    if (op.op === "remove")
      Array.isArray(parent) ? parent.splice(Number(last), 1) : delete parent[last];
    else if (Array.isArray(parent) && op.op === "add")
      parent.splice(last === "-" ? parent.length : Number(last), 0, op.value);
    else parent[last] = op.value;
  }
  return next;
}

const input = {
  threadId: process.env.MEETING_ID ?? "new",
  runId: crypto.randomUUID(),
  messages: [],
  tools: [],
  context: [],
  ...(process.env.MEETING_URL ? { forwardedProps: { meetingUrl: process.env.MEETING_URL } } : {}),
};
const res = await fetch(`${base}/agui`, { method: "POST", headers, body: JSON.stringify(input) });
if (!res.ok) throw new Error(`Open Meetings answered HTTP ${res.status}`);

let state = { decisions: [], actionItems: [] };
let buffer = "";
const decoder = new TextDecoder();
for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let end = buffer.indexOf("\n\n");
  while (end !== -1) {
    const data = buffer
      .slice(0, end)
      .split("\n")
      .find((line) => line.startsWith("data:"));
    buffer = buffer.slice(end + 2);
    end = buffer.indexOf("\n\n");
    if (!data) continue;
    const event = JSON.parse(data.slice(5));
    if (event.type === "RUN_STARTED")
      await slack(`Open Meetings is in the meeting: ${base}/meetings/${event.threadId}`);
    if (event.type === "STATE_SNAPSHOT") state = event.snapshot;
    if (event.type === "STATE_DELTA") {
      const next = applyPatch(state, event.delta);
      for (const d of next.decisions.slice(state.decisions.length))
        await slack(`:white_check_mark: Decision: ${d.text}`);
      for (const a of next.actionItems.slice(state.actionItems.length)) {
        await slack(
          `:pushpin: ${a.text}${a.owner ? ` (${a.owner}${a.due ? `, ${a.due}` : ""})` : ""}`,
        );
      }
      state = next;
    }
    if (event.type === "CUSTOM" && event.name === "om.minutes") await slack(event.value.markdown);
    if (event.type === "RUN_ERROR") throw new Error(event.message);
  }
}
