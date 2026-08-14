"""LexWork (Sitrox) cantonal law source: JSON API with XHTML full text."""
import json
import re
from collections.abc import Callable
from datetime import date
from pathlib import Path
from typing import Any

import httpx
from lxml import html as lhtml

from ingestion.akoma import MAX_CHUNK_CHARS
from ingestion.corpus import Act, Jurisdiction
from ingestion.models import Chunk, ManifestEntry, ResolveFailure

_STAND_RE = re.compile(r"(?:Stand|état(?:\s+au)?)\s+(\d{2})\.(\d{2})\.(\d{4})", re.IGNORECASE)

# corpus.yaml act numbers are Swiss systematic-collection numbers only
# ("811.1", "432.210") — never a path segment, so this also blocks a
# corpus.yaml typo (or, in principle, a hostile edit) from escaping raw_dir
# via the cache filename or injecting a path into the API URL (M2).
_ACT_NUMBER_RE = re.compile(r"^[0-9]+(\.[0-9]+)*$")


def version_date_from(enactment_text: str, enactment_iso: str | None) -> date:
    m = _STAND_RE.search(enactment_text)
    if m:
        return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    if enactment_iso:
        return date.fromisoformat(enactment_iso)
    raise ValueError(f"no version date in enactment text: {enactment_text!r}")


def api_url(base_url: str, lang: str, number: str) -> str:
    return f"{base_url}/api/{lang}/texts_of_law/{number}"


def _extract_xhtml(payload: dict[str, Any]) -> str | None:
    # Verified live shape (2026-08-13, SG 151.2): the response is
    # {"text_of_law": {..., "selected_version": {"xhtml_tol": "..."}}} — there is no
    # top-level or text_of_law-level "xhtml_tol" key. The other spellings are kept as
    # defensive fallbacks in case a different canton's LexWork instance nests it flatter.
    # "text_of_law" can be a present-but-null key (not just absent) — `or payload`
    # covers both, instead of `.get(..., payload)` which only defaults on absence and
    # leaves `tol` as None (then a bare AttributeError on the next `.get`) when null.
    xhtml = payload.get("xhtml_tol")
    if xhtml:
        return str(xhtml)
    tol = payload.get("text_of_law") or payload
    xhtml = tol.get("xhtml_tol")
    if xhtml:
        return str(xhtml)
    selected = tol.get("selected_version") or {}
    xhtml = selected.get("xhtml_tol")
    return str(xhtml) if xhtml else None


def _required(
    d: dict[str, Any] | None, key: str, jur: Jurisdiction, act: Act, lang: str
) -> Any:
    """Look up `key` in `d`, failing loud with jurisdiction/act/lang context.

    Treats both an absent key and a present-but-null value as "required value
    missing" — a renamed key and a `null` field in a BE (or other) act's
    LexWork response are the same failure mode from the caller's side, and
    neither should surface as a bare KeyError/AttributeError naming neither
    canton, act, nor language.
    """
    value = (d or {}).get(key)
    if value is None:
        raise ValueError(
            f"{jur.code} {act.number}/{lang}: missing or null '{key}' in LexWork response"
        )
    return value


def _assert_safe_lexwork_request(jur: Jurisdiction, act: Act) -> None:
    """Defense-in-depth guards mirroring fetch.py's Fedlex-side asserts (M2).

    corpus.yaml is repo-controlled (same trust level as code), so this isn't
    guarding against an adversary — it's guarding against a typo turning into
    a request to an unintended host or a cache path escaping raw_dir.
    """
    base_url = jur.base_url or ""
    if not base_url.startswith("https://"):
        raise ValueError(
            f"{jur.code}: lexwork base_url must start with https://, got {base_url!r} "
            "— check corpus.yaml"
        )
    if not _ACT_NUMBER_RE.match(act.number):
        raise ValueError(
            f"{jur.code} {act.number}: act number does not look like a systematic "
            f"collection number ({_ACT_NUMBER_RE.pattern}) — check corpus.yaml"
        )


def _resolve_lexwork_act(
    jur: Jurisdiction, act: Act, lang: str, client: httpx.Client, raw_dir: Path,
) -> ManifestEntry:
    _assert_safe_lexwork_request(jur, act)
    url = api_url(jur.base_url or "", lang, act.number)
    resp = client.get(url)
    resp.raise_for_status()
    payload = resp.json()
    tol = _required(payload, "text_of_law", jur, act, lang)
    xhtml = _extract_xhtml(payload)
    if not xhtml:
        raise ValueError(f"{jur.code} {act.number}/{lang}: no xhtml_tol in response")
    # The raw-cache filename and ManifestEntry.number must never diverge (I2): both
    # are keyed on corpus.yaml's act.number, and any disagreement with the API's own
    # systematic_number fails loud here instead of surfacing later as a cache-miss
    # whose suggested remedy (re-run resolve) can never succeed.
    api_number = _required(tol, "systematic_number", jur, act, lang)
    if api_number != act.number:
        raise ValueError(
            f"{jur.code} {act.number}/{lang}: LexWork API systematic_number "
            f"{api_number!r} does not match corpus.yaml's number {act.number!r} — "
            "correct corpus.yaml to the API's value"
        )
    out = raw_dir / jur.code / f"{act.number}.{lang}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    doc = lhtml.fromstring(xhtml)
    enactment = " ".join(doc.xpath("//div[@class='enactment']//text()"))
    return ManifestEntry(
        jurisdiction=jur.code, collection=jur.collection,
        number=act.number, lang=lang,
        act_name=_required(tol, "title", jur, act, lang),
        abbrev=(tol.get("abbreviation") or act.abbrev).strip("() "),
        version_date=version_date_from(enactment, tol.get("enactment")),
        source_url=_required(tol, "canonical_link", jur, act, lang),
        file_url=url, source="lexwork",
    )


def resolve_lexwork(
    jur: Jurisdiction, client: httpx.Client, raw_dir: Path,
    sleep: Callable[[float], None],
) -> tuple[list[ManifestEntry], list[ResolveFailure]]:
    entries: list[ManifestEntry] = []
    failures: list[ResolveFailure] = []
    for act in jur.acts:
        for lang in jur.languages:
            try:
                entries.append(_resolve_lexwork_act(jur, act, lang, client, raw_dir))
            except Exception as error:  # noqa: BLE001 — per-act resilience, spec §3
                failures.append(ResolveFailure(
                    jurisdiction=jur.code, number=act.number, lang=lang, error=str(error),
                ))
            finally:
                sleep(1.0)  # be polite to the LexWork endpoint regardless of outcome
    return entries, failures


def _text(el: lhtml.HtmlElement) -> str:
    return " ".join(t.strip() for t in el.itertext() if t.strip())


def _split_oversized_lexwork(article_no: str, text: str) -> list[tuple[int | None, str]]:
    # LexWork chunk text (built in flush() below as "\n".join(body)) is *only* the
    # paragraph texts — unlike Fedlex chunk text, its line 0 is not an "Art. N"
    # header. akoma._split_oversized repeats line 0 as a pseudo-header on every part,
    # which would repeat and double-embed paragraph 1 here. Synthesize a proper
    # "Art. {article_no}" header for continuation parts instead — never derived from
    # the body, so it's never duplicated content (I1).
    if len(text) <= MAX_CHUNK_CHARS:
        return [(None, text)]
    header = f"Art. {article_no}"
    parts: list[str] = []
    current = header
    for line in text.split("\n"):
        if len(current) + 1 + len(line) > MAX_CHUNK_CHARS and current != header:
            parts.append(current)
            current = header
        current = f"{current}\n{line}"
    parts.append(current)
    return [(i, part) for i, part in enumerate(parts, start=1)]


def parse_lexwork(json_path: Path, entry: ManifestEntry) -> list[Chunk]:
    payload = json.loads(json_path.read_text(encoding="utf-8"))
    xhtml = _extract_xhtml(payload)
    if not xhtml:
        raise ValueError(f"{json_path}: no xhtml_tol")
    doc = lhtml.fromstring(xhtml)
    root = doc if "document" in (doc.get("class") or "") else doc.find_class("document")[0]

    chunks: list[Chunk] = []
    breadcrumb: list[str] = []
    current_no: str | None = None
    current_heading: str | None = None
    body: list[str] = []

    def flush() -> None:
        nonlocal current_no, current_heading, body
        if current_no is None:
            return
        text = "\n".join(body).strip()
        if text and text not in {"…", "…*"}:  # abrogated articles carry only an ellipsis
            context = " › ".join(breadcrumb) or None
            for part, part_text in _split_oversized_lexwork(current_no, text):
                chunks.append(_build_chunk(
                    entry, current_no, current_heading, context, part_text, part
                ))
        current_no, current_heading, body = None, None, []

    for el in root:
        cls = el.get("class") or ""
        if cls.startswith("title level_"):
            flush()
            level = int(cls.rsplit("_", 1)[1])
            del breadcrumb[level - 1:]
            title_text = el.find_class("title_text")
            breadcrumb.append(_text(title_text[0]) if title_text else _text(el))
        elif cls == "article":
            flush()
            number_spans = el.find_class("number")
            if not number_spans:
                raise ValueError(
                    f"{entry.jurisdiction} {entry.number}/{entry.lang}: "
                    "article div has no 'number' span"
                )
            current_no = _text(number_spans[0])
            titles = el.find_class("title_text")
            current_heading = _text(titles[0]) if titles else None
        elif current_no is not None and cls in {"paragraph", "enumeration_item"}:
            # Partially-abrogated paragraphs (e.g. "3 …*") carry a span.abrogation_ellip
            # marker for their repealed content; drop them instead of leaking the
            # ellipsis into chunk text. Live paragraphs are unaffected.
            if cls == "paragraph" and el.find_class("abrogation_ellip"):
                continue
            body.append(_text(el))
    flush()
    if not chunks:
        raise ValueError(f"{entry.jurisdiction} {entry.number}/{entry.lang}: no articles parsed")
    return chunks


def _build_chunk(entry: ManifestEntry, article: str, heading: str | None,
                 context: str | None, text: str, part: int | None) -> Chunk:
    eid = "art_" + article.lower().replace(".", "_")
    return Chunk(
        jurisdiction=entry.jurisdiction, collection=entry.collection,
        number=entry.number, lang=entry.lang, article=article, eid=eid, part=part,
        heading=heading, context=context, text=text,
        source_url=entry.source_url, act_name=entry.act_name,
        abbrev=entry.abbrev, version_date=entry.version_date,
    )
