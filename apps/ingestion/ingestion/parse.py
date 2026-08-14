from pathlib import Path

from ingestion.akoma import parse_act
from ingestion.lexwork import parse_lexwork
from ingestion.models import Manifest


def parse_all(manifest: Manifest, raw_dir: Path, chunks_dir: Path) -> dict[str, int]:
    counts: dict[str, int] = {}
    for entry in manifest.entries:
        if entry.source == "fedlex":
            xml_path = raw_dir / entry.jurisdiction / entry.number / f"{entry.lang}.xml"
            chunks = parse_act(xml_path, entry)
        else:
            json_path = raw_dir / entry.jurisdiction / f"{entry.number}.{entry.lang}.json"
            chunks = parse_lexwork(json_path, entry)
        out = chunks_dir / entry.jurisdiction / entry.number / f"{entry.lang}.jsonl"
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(".jsonl.tmp")
        with tmp.open("w", encoding="utf-8") as f:
            for chunk in chunks:
                f.write(chunk.model_dump_json() + "\n")
        tmp.replace(out)
        counts[f"{entry.jurisdiction}/{entry.number}/{entry.lang}"] = len(chunks)
    return counts
