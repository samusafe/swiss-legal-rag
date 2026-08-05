from pathlib import Path

from ingestion.akoma import parse_act
from ingestion.models import Manifest


def parse_all(manifest: Manifest, raw_dir: Path, chunks_dir: Path) -> dict[str, int]:
    counts: dict[str, int] = {}
    for entry in manifest.entries:
        chunks = parse_act(raw_dir / entry.sr / f"{entry.lang}.xml", entry)
        out = chunks_dir / entry.sr / f"{entry.lang}.jsonl"
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(".jsonl.tmp")
        with tmp.open("w", encoding="utf-8") as f:
            for chunk in chunks:
                f.write(chunk.model_dump_json() + "\n")
        tmp.replace(out)
        counts[f"{entry.sr}/{entry.lang}"] = len(chunks)
    return counts
