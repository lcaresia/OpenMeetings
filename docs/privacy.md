# Privacy, consent and data protection (LGPD / GDPR)

Open Meetings records conversations. This page says what it stores, where, for how long, and
how to delete it. The person who runs the server is the data controller; this software gives
them the controls, not the legal assessment.

## Consent in the meeting

- The bot always joins under a name that says it is an AI assistant and posts a message in
  the call chat when it joins. Both are on by design and cannot be turned off
  (`consent.announceOnJoin: false` is rejected by the config).
- People who join later get the same message.
- Anyone in the call can type `om pausar` (stop recording now), `om continuar` or `om sair`
  (the bot leaves). These are matched literally and work even if no model is reachable. While
  paused, nothing that is said is stored, shown or sent to any model.
- External guests (`consent.externalGuests`): `allow` keeps going and re-announces; `ask`
  pauses until someone from the organization confirms; `leave` makes the bot leave. With
  `consent.internalDomains` set, anyone who cannot be placed inside those domains counts as
  external.
- The browser extension mode joins no call: there is no bot to announce itself. The person
  capturing must tell the others; the extension popup says so.

## What is stored

| Data                                                | Where                   | When                                             |
| --------------------------------------------------- | ----------------------- | ------------------------------------------------ |
| Transcript (speaker name, text, timing)             | SQLite (`storage.path`) | While the meeting runs                           |
| Notes (decisions, action items, questions, summary) | SQLite                  | While the meeting runs                           |
| Artifacts (documents, sheets, boards, timelines)    | SQLite                  | When created                                     |
| Minutes                                             | SQLite                  | When the meeting ends                            |
| Search vectors of transcript passages and minutes   | SQLite                  | When the meeting ends, if `engines.embed` is set |
| Model usage and cost per call (no content)          | SQLite                  | Per model call                                   |

Not stored: audio and video. Uploaded files are deleted as soon as they are processed. Captured
audio is only held in memory long enough to transcribe it.

## Where data goes

- **Local profile** (`profile: local`): nothing leaves the machine or the private network.
  Every outbound request goes through one guard that refuses non-private addresses; an
  automated test fails if any request leaves. Search over the web (`web_fetch`) is off.
- **Other profiles**: text is sent to the model providers you configured (transcript excerpts
  and notes to the LLMs; audio to the STT engine if you use one). Their own terms apply. The
  meeting platform (Google) also processes the call as usual.
- **Webhook**: if configured, the minutes and notes are posted to that URL when a meeting ends.
- Logs never contain API keys or tokens (they are redacted) and do not contain transcripts.

## Retention and deletion

- `consent.retentionDays` (default 90): a job deletes older meetings, with everything attached
  to them, every 6 hours and at startup. `0` keeps everything.
- Delete one meeting now: the "Delete meeting" button on the panel, or
  `DELETE /api/meetings/<id>`. This removes the transcript, notes, minutes, artifacts, search
  vectors and usage records of that meeting.
- Delete everything: stop the server and delete the database file (`/data/openmeetings.db` in
  Docker, the `om-data` volume).

## Access

The panel and every API endpoint require the server token when one is set, and `om doctor`
fails if the server listens beyond localhost without one. Put the server behind HTTPS before
exposing it ([deploy-vps.md](deploy-vps.md)).
