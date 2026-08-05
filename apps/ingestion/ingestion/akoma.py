import re
from collections import Counter
from pathlib import Path

from lxml import etree

from ingestion.models import Chunk, ManifestEntry

AKN_NS = "http://docs.oasis-open.org/legaldocml/ns/akn/3.0"
FEDLEX_NS = "http://fedlex.admin.ch/"

_ARTICLE_EID_RE = re.compile(r"^art_(.+)$")
_ARTICLE_NUMBER_RE = re.compile(r"^(\d+)([a-z]+)?$")


def _norm(text: str) -> str:
    return " ".join(text.split())


_REPEAL_ONLY_RE = re.compile(r"^(aufgehoben|abrogat[oiae]|abrog[ée]{1,2}s?)\.?$", re.IGNORECASE)


def article_number(eid: str) -> str:
    # Annex articles carry a path prefix ("anx_1/art_2") — number is the last segment.
    last = eid.rsplit("/", 1)[-1]
    match = _ARTICLE_EID_RE.match(last)
    if match is None:
        raise RuntimeError(f"unrecognized article eId: {eid}")
    return match.group(1).replace("_", "")


def _anchor_from_article(article: str) -> str:
    # Inverse of article_number, used only to synthesize a fresh eId anchor when a
    # duplicate source eId forces disambiguation (see parse_act).
    match = _ARTICLE_NUMBER_RE.match(article)
    if match is None:
        raise RuntimeError(f"cannot build eId anchor from article number: {article}")
    digits, letters = match.groups()
    return f"art_{digits}_{letters}" if letters else f"art_{digits}"


def article_text(article: etree._Element) -> str:
    num = article.find(f"{{{AKN_NS}}}num")
    header = _norm("".join(num.itertext())) if num is not None else ""
    lines = [header]
    paragraphs = article.findall(f".//{{{AKN_NS}}}paragraph")
    if paragraphs:
        for paragraph in paragraphs:
            pnum = paragraph.find(f"{{{AKN_NS}}}num")
            prefix = _norm("".join(pnum.itertext())) if pnum is not None else ""
            content = paragraph.find(f"{{{AKN_NS}}}content")
            body = _norm("".join(content.itertext())) if content is not None else ""
            lines.append(f"{prefix} {body}".strip())
    else:
        whole = _norm("".join(article.itertext()))
        rest = whole[len(header):].strip() if header and whole.startswith(header) else whole
        lines.append(rest)
    return "\n".join(line for line in lines if line)


def marginal_heading(article: etree._Element) -> str | None:
    for ancestor in article.iterancestors(f"{{{AKN_NS}}}level"):
        if ancestor.get(f"{{{FEDLEX_NS}}}role") == "marginal":
            heading = ancestor.find(f"{{{AKN_NS}}}heading")
            if heading is not None:
                return _norm("".join(heading.itertext()))
    return None


def marginal_breadcrumb(article: etree._Element) -> str | None:
    headings: list[str] = []
    for ancestor in article.iterancestors(f"{{{AKN_NS}}}level"):
        if ancestor.get(f"{{{FEDLEX_NS}}}role") == "marginal":
            heading = ancestor.find(f"{{{AKN_NS}}}heading")
            if heading is not None:
                headings.append(_norm("".join(heading.itertext())))
    if not headings:
        return None
    return " › ".join(reversed(headings))


MAX_CHUNK_CHARS = 8000
_HEADER_NUMBER_RE = re.compile(r"^\d+[a-z]*$")


def _split_oversized(text: str) -> list[tuple[int | None, str]]:
    if len(text) <= MAX_CHUNK_CHARS:
        return [(None, text)]
    header, *body_lines = text.split("\n")
    parts: list[str] = []
    current = header
    for line in body_lines:
        if len(current) + 1 + len(line) > MAX_CHUNK_CHARS and current != header:
            parts.append(current)
            current = header
        current = f"{current}\n{line}"
    parts.append(current)
    return [(i, part) for i, part in enumerate(parts, start=1)]


def parse_act(xml_path: Path, entry: ManifestEntry) -> list[Chunk]:
    if not xml_path.exists():
        raise RuntimeError(f"missing raw XML for SR {entry.sr} ({entry.lang}): {xml_path}")
    root = etree.parse(str(xml_path)).getroot()
    # Legislative-history footnotes are retrieval noise; drop them tree-wide once.
    etree.strip_elements(root, f"{{{AKN_NS}}}authorialNote", with_tail=False)
    articles = root.findall(f".//{{{AKN_NS}}}article")
    if not articles:
        raise RuntimeError(f"no articles found in SR {entry.sr} ({entry.lang}): {xml_path}")
    chunks: list[Chunk] = []
    for article in articles:
        eid = article.get("eId")
        if eid is None:
            raise RuntimeError(f"article without eId in SR {entry.sr} ({entry.lang})")
        text = article_text(article)
        header, _, body = text.partition("\n")
        # Repealed/not-yet-in-force articles have empty bodies after footnote stripping.
        # Also skip repeal-stub bodies (e.g., "Aufgehoben", "Abrogés").
        if not body.strip() or _REPEAL_ONLY_RE.match(body.strip()):
            continue
        number = article_number(eid)
        # SR 220 FR has duplicate source eIds (e.g. two <article eId="art_221">) where
        # the <num> text is authoritative; prefer it over the eId-derived number when
        # it looks like a real article number and disagrees with the eId.
        header_number = header.removeprefix("Art.").strip()
        if _HEADER_NUMBER_RE.match(header_number) and header_number != number:
            number = header_number
        heading = marginal_heading(article)
        context = marginal_breadcrumb(article)
        for part, part_text in _split_oversized(text):
            chunks.append(
                Chunk(
                    sr=entry.sr,
                    lang=entry.lang,
                    article=number,
                    eid=eid,
                    part=part,
                    heading=heading,
                    context=context,
                    text=part_text,
                    eli=f"{entry.eli}#{eid}",
                    act_name=entry.act_name,
                    abbrev=entry.abbrev,
                    version_date=entry.version_date,
                )
            )
    if not chunks:
        raise RuntimeError(f"no chunks produced for SR {entry.sr} ({entry.lang}): every article was empty or repealed")
    chunks = _disambiguate_duplicate_keys(chunks, entry)
    return chunks


def _disambiguate_duplicate_keys(chunks: list[Chunk], entry: ManifestEntry) -> list[Chunk]:
    # Fedlex XML has real duplicate source eIds (e.g. two <article eId="art_221"> in
    # SR 220 FR — one for Art. 220, one for Art. 221). Both chunks then share the same
    # (eli, part) key. Within a colliding group, the chunk whose article number
    # agrees with the eId keeps the original eId anchor (it's what resolves on
    # fedlex.admin.ch, so it's preferred whenever unique); the mislabeled one gets a
    # synthesized anchor built from its true article number instead. A single rewrite
    # can itself land on an anchor already used by an untouched singleton (SR 220 FR
    # is a 3-way chain: art_220 alone holds Art. 219's text via a plain header
    # override, while art_221 is duplicated between Art. 220 and Art. 221 — rehoming
    # Art. 220 onto "#art_220" collides with that untouched Art. 219 chunk). So this
    # loops to a fixed point: each pass only touches chunks currently in a colliding
    # group, which lets newly-created collisions cascade to resolution (Art. 219 then
    # moves to its own "#art_219", freeing "#art_220" for Art. 220) without touching
    # any mismatched chunk that was never actually colliding with anything.
    resolved = list(chunks)
    for _ in range(len(chunks) + 1):  # generous bound; real corpus converges in 2 passes
        key_counts = Counter((c.eli, c.part or 0) for c in resolved)
        changed = False
        next_resolved: list[Chunk] = []
        for chunk in resolved:
            key = (chunk.eli, chunk.part or 0)
            if key_counts[key] > 1 and chunk.article != article_number(chunk.eid):
                new_eli = f"{entry.eli}#{_anchor_from_article(chunk.article)}"
                if new_eli != chunk.eli:
                    chunk = chunk.model_copy(update={"eli": new_eli})
                    changed = True
            next_resolved.append(chunk)
        resolved = next_resolved
        if not changed:
            break

    final_counts = Counter((chunk.eli, chunk.part or 0) for chunk in resolved)
    for key, count in final_counts.items():
        if count > 1:
            articles = [c.article for c in resolved if (c.eli, c.part or 0) == key]
            raise RuntimeError(
                f"duplicate chunk key survived eId disambiguation for SR {entry.sr} "
                f"({entry.lang}): eli={key[0]} part={key[1]} articles={articles}"
            )
    return resolved
