import re
from pathlib import Path

from lxml import etree

from ingestion.models import Chunk, ManifestEntry

AKN_NS = "http://docs.oasis-open.org/legaldocml/ns/akn/3.0"
FEDLEX_NS = "http://fedlex.admin.ch/"

_ARTICLE_EID_RE = re.compile(r"^art_(.+)$")


def _norm(text: str) -> str:
    return " ".join(text.split())


def article_number(eid: str) -> str:
    # Annex articles carry a path prefix ("anx_1/art_2") — number is the last segment.
    last = eid.rsplit("/", 1)[-1]
    match = _ARTICLE_EID_RE.match(last)
    if match is None:
        raise RuntimeError(f"unrecognized article eId: {eid}")
    return match.group(1).replace("_", "")


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
        if not body.strip():
            continue
        number = article_number(eid)
        # SR 220 FR has duplicate source eIds (e.g. two <article eId="art_221">) where
        # the <num> text is authoritative; prefer it over the eId-derived number when
        # it looks like a real article number and disagrees with the eId.
        header_number = header.removeprefix("Art.").strip()
        if _HEADER_NUMBER_RE.match(header_number) and header_number != number:
            number = header_number
        heading = marginal_heading(article)
        for part, part_text in _split_oversized(text):
            chunks.append(
                Chunk(
                    sr=entry.sr,
                    lang=entry.lang,
                    article=number,
                    part=part,
                    heading=heading,
                    text=part_text,
                    eli=f"{entry.eli}#{eid}",
                    act_name=entry.act_name,
                    abbrev=entry.abbrev,
                    version_date=entry.version_date,
                )
            )
    return chunks
