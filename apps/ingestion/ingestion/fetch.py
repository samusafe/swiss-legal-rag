from collections.abc import Callable
from pathlib import Path

import httpx

from ingestion.models import Manifest


def fetch_all(
    manifest: Manifest,
    client: httpx.Client,
    raw_dir: Path,
    sleep: Callable[[float], None],
) -> list[Path]:
    downloaded: list[Path] = []
    for entry in manifest.entries:
        target = raw_dir / entry.sr / f"{entry.lang}.xml"
        if target.exists():
            continue  # cached — pipeline is re-runnable offline
        if downloaded:
            sleep(1.0)  # be polite to the Fedlex endpoint (~1 req/s)
        response = client.get(entry.file_url)
        if response.status_code != 200:
            raise RuntimeError(
                f"download failed ({response.status_code}): {entry.file_url}"
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(response.content)
        downloaded.append(target)
    return downloaded
