from collections.abc import Callable
from datetime import date

import httpx

from ingestion.corpus import CorpusConfig
from ingestion.models import Manifest, ManifestEntry
from ingestion.sparql import eli_from_file_url, pick_current, run_query


def resolve_corpus(
    corpus: CorpusConfig,
    client: httpx.Client,
    today: date,
    sleep: Callable[[float], None],
) -> Manifest:
    entries: list[ManifestEntry] = []
    for index, act in enumerate(corpus.acts):
        if index > 0:
            sleep(1.0)  # be polite to the Fedlex endpoint (~1 req/s)
        rows = run_query(client, act.sr)
        current = pick_current(rows, corpus.languages, today)
        for lang in corpus.languages:
            version = current[lang]
            entries.append(
                ManifestEntry(
                    sr=act.sr,
                    lang=lang,
                    act_name=act.name,
                    abbrev=act.abbrev,
                    version_date=version.version_date,
                    eli=eli_from_file_url(version.file_url, lang),
                    file_url=version.file_url,
                )
            )
    entries.sort(key=lambda e: (e.sr, e.lang))
    return Manifest(entries=entries)
