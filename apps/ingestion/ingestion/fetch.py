import json
import os
from collections.abc import Callable
from pathlib import Path

import httpx

from ingestion.models import FetchMeta, Manifest

ALLOWED_URL_PREFIX = "https://fedlex.data.admin.ch/"
MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024  # generous cap for a single Fedlex act XML file


def _meta_path(raw_dir: Path, jurisdiction: str, number: str) -> Path:
    return raw_dir / jurisdiction / number / "fetch-meta.json"


def _load_meta(path: Path) -> dict[str, FetchMeta]:
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {lang: FetchMeta.model_validate(value) for lang, value in raw.items()}


def _save_meta(path: Path, meta: dict[str, FetchMeta]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {lang: fm.model_dump(mode="json") for lang, fm in meta.items()}
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def _download(client: httpx.Client, url: str, target: Path) -> None:
    if not url.startswith(ALLOWED_URL_PREFIX):
        raise RuntimeError(f"refusing to fetch from untrusted host: {url}")
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    try:
        with client.stream("GET", url) as response:
            if response.status_code != 200:
                raise RuntimeError(f"download failed ({response.status_code}): {url}")
            size = 0
            with tmp.open("wb") as f:
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > MAX_DOWNLOAD_BYTES:
                        raise RuntimeError(
                            f"download exceeds {MAX_DOWNLOAD_BYTES}-byte cap: {url}"
                        )
                    f.write(chunk)
    except BaseException:
        tmp.unlink(missing_ok=True)  # never leave a partial download at the .tmp path
        raise
    os.replace(tmp, target)  # atomic: `target` only ever holds a complete download


def fetch_all(
    manifest: Manifest,
    client: httpx.Client,
    raw_dir: Path,
    sleep: Callable[[float], None],
) -> list[Path]:
    downloaded: list[Path] = []
    meta_cache: dict[tuple[str, str], dict[str, FetchMeta]] = {}
    for entry in manifest.entries:
        if entry.source == "lexwork":
            # lexwork downloads happen in resolve.py, never here — just confirm the
            # cached JSON that resolve wrote is actually on disk.
            cached = raw_dir / entry.jurisdiction / f"{entry.number}.{entry.lang}.json"
            if not cached.exists():
                raise RuntimeError(
                    f"missing cached LexWork JSON for {entry.jurisdiction} {entry.number} "
                    f"({entry.lang}): {cached} — re-run `ingest resolve`"
                )
            continue
        target = raw_dir / entry.jurisdiction / entry.number / f"{entry.lang}.xml"
        meta_path = _meta_path(raw_dir, entry.jurisdiction, entry.number)
        meta_key = (entry.jurisdiction, entry.number)
        meta = meta_cache.setdefault(meta_key, _load_meta(meta_path))
        fingerprint = FetchMeta(file_url=entry.file_url, version_date=entry.version_date)
        if target.exists() and meta.get(entry.lang) == fingerprint:
            continue  # cache hit — same source URL and Fedlex version_date already downloaded
        if downloaded:
            sleep(1.0)  # be polite to the Fedlex endpoint (~1 req/s)
        _download(client, entry.file_url, target)
        meta[entry.lang] = fingerprint
        _save_meta(meta_path, meta)
        downloaded.append(target)
    return downloaded
