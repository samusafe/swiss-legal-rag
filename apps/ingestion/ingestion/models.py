from datetime import date
from pathlib import Path
from typing import Literal

from pydantic import BaseModel


class ManifestEntry(BaseModel):
    jurisdiction: str
    collection: str
    number: str
    lang: str
    act_name: str
    abbrev: str
    version_date: date
    source_url: str
    file_url: str
    source: Literal["fedlex", "lexwork"]


class FetchMeta(BaseModel):
    """Per-language fetch fingerprint, cached in data/raw/<jurisdiction>/<number>/fetch-meta.json."""

    file_url: str
    version_date: date


class ResolveFailure(BaseModel):
    """One act (optionally one act/language) that failed to resolve.

    Collected instead of raised so a single bad act (404, malformed API
    response, corpus.yaml/API mismatch) never discards the whole run — see
    spec §3 per-act resilience.
    """

    jurisdiction: str
    number: str
    lang: str | None = None
    error: str


class Manifest(BaseModel):
    entries: list[ManifestEntry]

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.model_dump_json(indent=2), encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> "Manifest":
        return cls.model_validate_json(path.read_text(encoding="utf-8"))


class Chunk(BaseModel):
    jurisdiction: str
    collection: str
    number: str
    lang: str
    article: str
    eid: str
    part: int | None = None
    heading: str | None
    context: str | None = None
    text: str
    source_url: str
    act_name: str
    abbrev: str
    version_date: date
