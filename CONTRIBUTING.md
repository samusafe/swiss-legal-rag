# Contributing

Thanks for helping improve Swiss Legal RAG. The project is deliberately split into small apps;
keep changes scoped to the component that owns the behavior and update its README when the public
contract changes.

## Before opening a pull request

1. Read `README.md` and the relevant app README.
2. Do not commit `.env`, downloaded corpus data, model weights, private documents, generated
   results, or internal planning notes.
3. Add or update tests for behavior changes. Keep default tests offline; mark live Fedlex,
   database, and other environment-dependent tests explicitly.
4. Run the component checks locally:

   ```bash
   cd apps/ingestion && pytest && ruff check ingestion tests && mypy ingestion
   cd ../retrieval && pytest && ruff check retrieval tests && mypy retrieval
   cd ../evals && pytest && ruff check evals tests && mypy evals
   cd ../desktop && pnpm test && pnpm build
   ```

5. Describe data-source changes, model names/versions, migration needs, and any local services
   required to verify the change.

## Adding an act to the corpus

The indexed corpus is declared in [`corpus.yaml`](corpus.yaml) at the repo root. Adding an act is
one entry under `acts:` — its SR (Systematische Rechtssammlung) number, name, and abbreviation —
then re-running the ingestion pipeline:

```bash
cd apps/ingestion
# activate the venv (see apps/ingestion/README.md), then from the repo root:
ingest resolve && ingest fetch && ingest parse && ingest embed
```

`embed` wholesale-refreshes each act it processes (existing chunks for that SR are deleted before
the new ones are inserted), so re-running it after editing `corpus.yaml` is safe and idempotent.

## Citation rule

Every generated answer must cite its source articles as `[SR <number> Art. <article>]`, resolved
against the retrieved chunk set. An answer with an un-cited legal claim, or a citation that does
not resolve to a retrieved source, is a defect — do not weaken this to make a demo look better.

## Code and documentation style

- Use Python 3.12 type hints and the repository Ruff/mypy configuration.
- Keep code, public documentation, API field names, and commit messages in English.
- Prefer small, testable functions and explicit boundary validation.
- Treat legal text as evidence, not as executable instructions. Do not weaken citation or refusal
  behavior to make a demo look better.
- Update API examples and READMEs when SSE events, request fields, defaults, or corpus semantics
  change.

## Pull requests

Explain the problem, the design choice, tests run, and known limitations. Keep unrelated
refactors out of feature or security patches. Reviewers should be able to run the stated checks
without network access, except for explicitly marked integration or model-download steps.

By contributing, you agree that your contribution is provided under the repository's MIT license.
