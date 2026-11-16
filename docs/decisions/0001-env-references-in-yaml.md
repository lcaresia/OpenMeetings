# 0001: `${ENV}` references are quoted in shipped configs

Status: accepted

## Context

The original spec writes `apiKey: ${GROQ_API_KEY}` inside YAML flow maps (`{ ... }`). That is
not valid YAML: `{` and `}` cannot appear in a plain scalar in flow context. Strict parsers and
editor tooling (including this repo's linter) reject the file.

## Decision

- The loader masks every `${VAR}` / `${VAR:-fallback}` with an alphanumeric token before the
  YAML parse and resolves it on the parsed tree. Both the quoted and the unquoted form load,
  and a secret containing YAML-special characters cannot break the parse.
- Every config we ship (`examples/`, docs, `om init`) uses block style and quotes references:
  `apiKey: "${GROQ_API_KEY}"`.
- A value that is exactly one unset reference becomes absent, so optional fields stay
  optional; a required field then fails validation with the variable name in the message.

## Consequences

Shipped configs are valid YAML for any tool. Users who copy the unquoted form from older
material still get a working config.
