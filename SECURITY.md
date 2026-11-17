# Security policy

Open Meetings handles recorded conversations and API keys, so security reports are welcome
and taken seriously.

## Reporting

Please **do not open a public issue**. Use GitHub's
[private vulnerability reporting](../../security/advisories/new) for this repository. Include
what you found, how to reproduce it, and the version (`om --version` or the image tag).

You will get an acknowledgement within a week. Fixes are released as soon as they are ready,
and credited in the release notes unless you prefer otherwise.

## Supported versions

The latest minor release gets security fixes.

## Scope notes

In scope: authentication bypass, access to meetings or artifacts without the token, secrets
leaking into logs or responses, the local profile sending data off the machine, injection
through meeting content (captions, chat) that makes the agent run an action without the
confirmation step.

Out of scope: denial of service by a client that already has the token, issues in third-party
model providers or meeting platforms, and running the server on a public address without a
token (the documentation and `om doctor` require one).

## Hardening checklist for operators

- Set `OM_AUTH_TOKEN` and `OM_BOT_TOKEN` to long random values.
- Expose the server only through HTTPS (docs/deploy-vps.md).
- Keep `autoApprove` lists short: tools with side effects should ask first.
- Use a dedicated Google account for the bot, never a personal one.
- Set `consent.retentionDays` to what your organization needs.
