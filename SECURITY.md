# Security policy

## Scope

This project is a local research application for Swiss federal-law documents. The default
deployment is intended for one trusted user on one machine. The retrieval API supports opt-in,
off-by-default hardening — an `API_KEY`-checked `X-API-Key` header and a single-process, per-IP
`RATE_LIMIT_PER_MINUTE` token bucket (see `apps/retrieval/README.md` Security) — but has no
authorization or tenant isolation, and `/ingest` can start a local ingestion subprocess. Do not
expose it to a LAN or the public internet, with or without those settings enabled.

Keep PostgreSQL, Ollama, and the retrieval API bound to `127.0.0.1`. Do not place real secrets in
`.env` files committed to Git, and do not upload private documents, logs, prompts, or evaluation
outputs to an issue or pull request.

## Reporting a vulnerability

Please do not disclose an exploitable vulnerability in a public issue. Report it privately through
[GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
for this repository (**Security** tab → **Report a vulnerability**). Include:

- a short description and impact;
- affected component, version/commit, and deployment assumptions;
- reproducible steps or a minimal proof of concept;
- any suggested mitigation.

If private reporting is not enabled on the repository yet, open a public issue containing only the
words `security contact requested` and no exploit details; the maintainer will follow up privately.

## Security expectations for contributions

Contributions should validate untrusted XML, URLs, model output, HTTP responses, and user input at
their boundaries. Preserve the Fedlex host restriction, download size limit, atomic cache writes,
secure XML parser configuration, bounded request fields, and localhost-only Docker/API defaults.
Keep `API_KEY` and `RATE_LIMIT_PER_MINUTE` opt-in and off by default so existing local deployments
keep working unchanged; never log the configured API key.
Avoid logging connection strings, credentials, private document text, or complete prompts.

Security fixes may be backported or released separately from normal feature work.
