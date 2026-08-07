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
        raise RuntimeError(f"missing raw XML for SR {entry.sr} ({entry.lang}): {xml_path}")
    root = etree.parse(str(xml_path), parser=_XML_PARSER).getroot()
    # Legislative-history footnotes are retrieval noise; drop them tree-wide once.
    etree.strip_elements(root, f"{{{AKN_NS}}}authorialNote", with_tail=False)
    articles = root.findall(f".//{{{AKN_NS}}}article")
    if not articles:
        raise RuntimeError(f"no articles found in SR {entry.sr} ({entry.lang}): {xml_path}")
    chunks: list[Chunk] = []
    eid_articles: dict[str, set[str]] = {}
    for article in articles:
        eid = article.get("eId")
        if eid is None:
            raise RuntimeError(f"article without eId in SR {entry.sr} ({entry.lang})")
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
    chunks = _disambiguate_duplicate_keys(chunks, entry, eid_articles)
    return chunks


def _disambiguate_duplicate_keys(
    chunks: list[Chunk], entry: ManifestEntry, eid_articles: dict[str, set[str]]
) -> list[Chunk]:
    # Fedlex XML has real duplicate source eIds (e.g. two <article eId="art_221"> in
    # SR 220 FR — one for Art. 220, one for Art. 221). Both chunks then share the same
    # (eli, part) key. Within a colliding group, a mislabeled chunk gets rehomed to a
    # synthesized anchor, but only if that anchor is not already owned by a different
    # article's element in this document — an anchor absent from the document is
    # harmless (browsers ignore unknown fragments), one owned by someone else falls
    # back to the bare act-level ELI instead. This loops to a fixed point since a
    # rewrite can create new collisions. In real FR SR 220 this means the 3-way chain
    # no longer cascades: Art. 219 keeps "#art_220" (that element holds its text),
    # and Art. 220 falls back to the act-level ELI (art_220 is owned by Art. 219).
    resolved = list(chunks)
    for _ in range(len(chunks) + 1):  # generous bound; real corpus converges in 2 passes
        key_counts = Counter((c.eli, c.part or 0) for c in resolved)
        changed = False
        next_resolved: list[Chunk] = []
        for chunk in resolved:
            key = (chunk.eli, chunk.part or 0)
            if key_counts[key] > 1 and chunk.article != article_number(chunk.eid):
                new_eli = _rehome_eli(chunk, entry, eid_articles)
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


def _rehome_eli(chunk: Chunk, entry: ManifestEntry, eid_articles: dict[str, set[str]]) -> str:
    # A synthesized top-level anchor for a nested (annex) article would point outside
    # the annex — link the act instead.
    if "/" in chunk.eid:
        return entry.eli
    anchor = _anchor_from_article(chunk.article)
    owners = eid_articles.get(anchor)
    if owners is not None and chunk.article not in owners:
        # The anchor exists in the document but belongs to a different article —
        # never point a citation at someone else's element. Act-level link instead.
        return entry.eli
    return f"{entry.eli}#{anchor}"
