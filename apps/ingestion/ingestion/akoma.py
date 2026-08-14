import re
from collections import Counter
from pathlib import Path

from lxml import etree

from ingestion.models import Chunk, ManifestEntry

AKN_NS = "http://docs.oasis-open.org/legaldocml/ns/akn/3.0"
FEDLEX_NS = "http://fedlex.admin.ch/"

# Fedlex XML is fetched from a trusted host, but parse defensively regardless: never
# substitute entities (blocks XXE file/network disclosure), never load an external DTD,
# never fetch over the network, and cap tree size against decompression-bomb-style input.
_XML_PARSER = etree.XMLParser(
    resolve_entities=False, load_dtd=False, no_network=True, huge_tree=False
)

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
        raise RuntimeError(f"missing raw XML for SR {entry.number} ({entry.lang}): {xml_path}")
    root = etree.parse(str(xml_path), parser=_XML_PARSER).getroot()
    # Legislative-history footnotes are retrieval noise; drop them tree-wide once.
    etree.strip_elements(root, f"{{{AKN_NS}}}authorialNote", with_tail=False)
    articles = root.findall(f".//{{{AKN_NS}}}article")
    if not articles:
        raise RuntimeError(f"no articles found in SR {entry.number} ({entry.lang}): {xml_path}")
    chunks: list[Chunk] = []
    eid_articles: dict[str, set[str]] = {}
    for article in articles:
        eid = article.get("eId")
        if eid is None:
            raise RuntimeError(f"article without eId in SR {entry.number} ({entry.lang})")
        text = article_text(article)
        header, _, body = text.partition("\n")
        number = article_number(eid)
        # SR 220 FR has duplicate source eIds (e.g. two <article eId="art_221">) where
        # the <num> text is authoritative; prefer it over the eId-derived number when
        # it looks like a real article number and disagrees with the eId.
        header_number = header.removeprefix("Art.").strip()
        if _HEADER_NUMBER_RE.match(header_number) and header_number != number:
            number = header_number
        eid_articles.setdefault(eid, set()).add(number)
        # Repealed/not-yet-in-force articles have empty bodies after footnote stripping.
        # Also skip repeal-stub bodies (e.g., "Aufgehoben", "Abrogés").
        if not body.strip() or _REPEAL_ONLY_RE.match(body.strip()):
            continue
        heading = marginal_heading(article)
        context = marginal_breadcrumb(article)
        for part, part_text in _split_oversized(text):
            chunks.append(
                Chunk(
                    jurisdiction=entry.jurisdiction,
                    collection=entry.collection,
                    number=entry.number,
                    lang=entry.lang,
                    article=number,
                    eid=eid,
                    part=part,
                    heading=heading,
                    context=context,
                    text=part_text,
                    source_url=f"{entry.source_url}#{eid}",
                    act_name=entry.act_name,
                    abbrev=entry.abbrev,
                    version_date=entry.version_date,
                )
            )
    if not chunks:
        raise RuntimeError(f"no chunks produced for SR {entry.number} ({entry.lang}): every article was empty or repealed")
    chunks = _disambiguate_duplicate_keys(chunks, entry, eid_articles)
    return chunks


def _disambiguate_duplicate_keys(
    chunks: list[Chunk], entry: ManifestEntry, eid_articles: dict[str, set[str]]
) -> list[Chunk]:
    # Fedlex XML has real duplicate source eIds (e.g. two <article eId="art_221"> in
    # SR 220 FR — one for Art. 220, one for Art. 221). Both chunks then share the same
    # (source_url, part) key. Within a colliding group, a mislabeled chunk gets rehomed to a
    # synthesized anchor, but only if that anchor is not already owned by a different
    # article's element in this document — an anchor absent from the document is
    # harmless (browsers ignore unknown fragments), one owned by someone else falls
    # back to the bare act-level source URL instead. This loops to a fixed point since a
    # rewrite can create new collisions. In real FR SR 220 this means the 3-way chain
    # no longer cascades: Art. 219 keeps "#art_220" (that element holds its text),
    # and Art. 220 falls back to the act-level source URL (art_220 is owned by Art. 219).
    resolved = list(chunks)
    for _ in range(len(chunks) + 1):  # generous bound; real corpus converges in 2 passes
        key_counts = Counter((c.source_url, c.part or 0) for c in resolved)
        changed = False
        next_resolved: list[Chunk] = []
        for chunk in resolved:
            key = (chunk.source_url, chunk.part or 0)
            if key_counts[key] > 1 and chunk.article != article_number(chunk.eid):
                new_source_url = _rehome_source_url(chunk, entry, eid_articles)
                if new_source_url != chunk.source_url:
                    chunk = chunk.model_copy(update={"source_url": new_source_url})
                    changed = True
            next_resolved.append(chunk)
        resolved = next_resolved
        if not changed:
            break

    final_counts = Counter((chunk.source_url, chunk.part or 0) for chunk in resolved)
    for key, count in final_counts.items():
        if count > 1:
            articles = [c.article for c in resolved if (c.source_url, c.part or 0) == key]
            raise RuntimeError(
                f"duplicate chunk key survived eId disambiguation for SR {entry.number} "
                f"({entry.lang}): source_url={key[0]} part={key[1]} articles={articles}"
            )

    resolved = _disambiguate_eids(resolved)

    eid_key_counts = Counter((chunk.eid, chunk.part or 0) for chunk in resolved)
    for key, count in eid_key_counts.items():
        if count > 1:
            articles = [c.article for c in resolved if (c.eid, c.part or 0) == key]
            raise RuntimeError(
                f"duplicate (eid, part) key survived eId disambiguation for SR {entry.number} "
                f"({entry.lang}): eid={key[0]} part={key[1]} articles={articles}"
            )
    return resolved


def _disambiguate_eids(chunks: list[Chunk]) -> list[Chunk]:
    # The source_url rehoming above never touches chunk.eid, so every chunk sharing a
    # duplicate Fedlex source eId (e.g. two <article eId="art_221">) still carries that
    # identical eid — which now collides on the DB's
    # (jurisdiction, number, lang, eid, part) unique key (embed.SCHEMA_SQL). Give every
    # duplicate but the "winner" (the one whose article matches the eId-derived number,
    # i.e. the one this eId actually belongs to) a deterministic ordinal suffix
    # ("art_221" -> "art_221__2", "__3", ...). "__" never appears in real Fedlex eIds
    # (which use single underscores, e.g. "art_6_a"), so a synthesized eid can never
    # collide with a genuine one. source_url is untouched here — it already points at
    # whatever anchor _rehome_source_url decided was safe, independent of this eid.
    eid_positions: dict[str, list[int]] = {}
    for i, chunk in enumerate(chunks):
        eid_positions.setdefault(chunk.eid, []).append(i)
    resolved = list(chunks)
    for eid, positions in eid_positions.items():
        if len(positions) <= 1:
            continue
        winner = next(
            (i for i in positions if chunks[i].article == article_number(chunks[i].eid)),
            positions[0],
        )
        ordinal = 2
        for i in positions:
            if i == winner:
                continue
            resolved[i] = resolved[i].model_copy(update={"eid": f"{eid}__{ordinal}"})
            ordinal += 1
    return resolved


def _rehome_source_url(
    chunk: Chunk, entry: ManifestEntry, eid_articles: dict[str, set[str]]
) -> str:
    # A synthesized top-level anchor for a nested (annex) article would point outside
    # the annex — link the act instead.
    if "/" in chunk.eid:
        return entry.source_url
    anchor = _anchor_from_article(chunk.article)
    owners = eid_articles.get(anchor)
    if owners is not None and chunk.article not in owners:
        # The anchor exists in the document but belongs to a different article —
        # never point a citation at someone else's element. Act-level link instead.
        return entry.source_url
    return f"{entry.source_url}#{anchor}"
