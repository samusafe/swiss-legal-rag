from collections.abc import Callable
from datetime import date
from pathlib import Path

import httpx

from ingestion.corpus import CorpusConfig
from ingestion.lexwork import resolve_lexwork
from ingestion.models import Manifest, ManifestEntry, ResolveFailure
from ingestion.sparql import eli_from_file_url, pick_current, run_query


def resolve_corpus(
    corpus: CorpusConfig,
    client: httpx.Client,
    today: date,
    sleep: Callable[[float], None],
    raw_dir: Path,
) -> tuple[Manifest, list[ResolveFailure]]:
    entries: list[ManifestEntry] = []
    failures: list[ResolveFailure] = []
    queried = 0
    for jur in corpus.jurisdictions:
        if jur.source == "lexwork":
            jur_entries, jur_failures = resolve_lexwork(jur, client, raw_dir, sleep)
            entries += jur_entries
            failures += jur_failures
            continue
        for act in jur.acts:
            if queried > 0:
                sleep(1.0)  # be polite to the Fedlex endpoint (~1 req/s)
            queried += 1
            # Per-act resilience (spec §3): a bad act (404, unexpected SPARQL shape,
            # missing consolidation) is collected and the run continues with the rest
            # — mirrors resolve_lexwork's per-act/lang try/except above.
            try:
                rows = run_query(client, act.number)
                current = pick_current(rows, jur.languages, today)
                for lang in jur.languages:
                    version = current[lang]
                    entries.append(
                        ManifestEntry(
                            jurisdiction=jur.code,
                            collection=jur.collection,
                            number=act.number,
                            lang=lang,
                            act_name=act.name,
                            abbrev=act.abbrev,
                            version_date=version.version_date,
                            source_url=eli_from_file_url(version.file_url, lang),
                            file_url=version.file_url,
                            source="fedlex",
                        )
                    )
            except Exception as error:  # noqa: BLE001 — per-act resilience, spec §3
                failures.append(
                    ResolveFailure(jurisdiction=jur.code, number=act.number, error=str(error))
                )
    entries.sort(key=lambda e: (e.jurisdiction, e.number, e.lang))
    return Manifest(entries=entries), failures
