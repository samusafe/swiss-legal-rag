import argparse
import time
from datetime import date
from pathlib import Path

import httpx

from ingestion.corpus import load_corpus
from ingestion.fetch import fetch_all
from ingestion.models import Manifest
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

    parser = argparse.ArgumentParser(prog="ingest", description="Fedlex corpus ingestion")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser(
        "resolve", parents=[common], help="SPARQL-resolve current versions to manifest.json"
    )
    subparsers.add_parser(
        "fetch", parents=[common], help="download Akoma Ntoso XML per manifest.json"
    )
    args = parser.parse_args(argv)

    manifest_path = args.data_dir / "manifest.json"
    with _make_client() as client:
        if args.command == "resolve":
            corpus = load_corpus(args.corpus)
            manifest = resolve_corpus(corpus, client, today=date.today(), sleep=time.sleep)
            manifest.save(manifest_path)
            print(f"resolved {len(manifest.entries)} act-language versions -> {manifest_path}")
        elif args.command == "fetch":
            manifest = Manifest.load(manifest_path)
            downloaded = fetch_all(manifest, client, args.data_dir / "raw", sleep=time.sleep)
            skipped = len(manifest.entries) - len(downloaded)
            print(f"downloaded {len(downloaded)} files, {skipped} cached")


if __name__ == "__main__":
    main()
