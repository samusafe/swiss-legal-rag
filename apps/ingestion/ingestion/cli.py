import argparse
import sys
import time
from datetime import date
from pathlib import Path

import httpx

from ingestion.corpus import load_corpus
from ingestion.embed import run_embed
from ingestion.fetch import fetch_all
from ingestion.models import Manifest
from ingestion.parse import parse_all
from ingestion.resolve import resolve_corpus


def _make_client() -> httpx.Client:
    return httpx.Client(timeout=60.0, follow_redirects=True)


def main(argv: list[str] | None = None) -> None:
    # Shared as `parents=` on each subparser so --corpus/--data-dir are only
    # valid AFTER the subcommand (e.g. `ingest resolve --corpus X`), not before.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--corpus",
        type=Path,
        default=Path("corpus.yaml"),
        help="path to the corpus manifest (default: corpus.yaml)",
    )
    common.add_argument(
        "--data-dir",
        type=Path,
        default=Path("data"),
        help="directory for manifest.json and raw/ downloads (default: data)",
    )

    parser = argparse.ArgumentParser(
        prog="ingest", description="Corpus ingestion (Fedlex + cantonal sources)"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser(
        "resolve", parents=[common], help="SPARQL-resolve current versions to manifest.json"
    )
    subparsers.add_parser(
        "fetch", parents=[common], help="download Akoma Ntoso XML per manifest.json"
    )
    subparsers.add_parser(
        "parse", parents=[common], help="parse raw Akoma Ntoso XML into article chunk JSONL files"
    )
    subparsers.add_parser(
        "embed", parents=[common], help="embed chunks into Postgres/pgvector via Ollama"
    )
    args = parser.parse_args(argv)

    manifest_path = args.data_dir / "manifest.json"

    if args.command == "resolve" or args.command == "fetch":
        with _make_client() as client:
            if args.command == "resolve":
                corpus = load_corpus(args.corpus)
                manifest, failures = resolve_corpus(
                    corpus, client, today=date.today(), sleep=time.sleep,
                    raw_dir=args.data_dir / "raw",
                )
                # Save whatever succeeded even when some acts failed (spec §3) — a
                # single bad act must not discard the rest of a multi-hour resolve.
                manifest.save(manifest_path)
                print(f"resolved {len(manifest.entries)} act-language versions -> {manifest_path}")
                if failures:
                    print(f"{len(failures)} act(s) failed to resolve:", file=sys.stderr)
                    for failure in failures:
                        lang_part = f"/{failure.lang}" if failure.lang else ""
                        print(
                            f"  {failure.jurisdiction} {failure.number}{lang_part}: "
                            f"{failure.error}",
                            file=sys.stderr,
                        )
                    sys.exit(1)
            elif args.command == "fetch":
                manifest = Manifest.load(manifest_path)
                downloaded = fetch_all(manifest, client, args.data_dir / "raw", sleep=time.sleep)
                skipped = len(manifest.entries) - len(downloaded)
                print(f"downloaded {len(downloaded)} files, {skipped} cached")
    elif args.command == "parse":
        manifest = Manifest.load(manifest_path)
        counts = parse_all(manifest, args.data_dir / "raw", args.data_dir / "chunks")
        print(
            f"parsed {sum(counts.values())} chunks from {len(counts)} act-language files "
            f"-> {args.data_dir / 'chunks'}"
        )
    elif args.command == "embed":
        run_embed(args.data_dir)


if __name__ == "__main__":
    main()
