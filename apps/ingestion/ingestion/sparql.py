import re
from datetime import date

import httpx
from pydantic import BaseModel

SPARQL_ENDPOINT = "https://fedlex.data.admin.ch/sparqlendpoint"

# Language authority URIs end in DEU/FRA/ITA; corpus languages are de/fr/it.
_LANG_TAG_TO_CODE = {"DEU": "de", "FRA": "fr", "ITA": "it"}

# Validated live on 2026-08-05 for SR 220. Returns ALL consolidations,
# including future-dated ones; filtering to "current" happens in pick_current.
_QUERY_TEMPLATE = """\
PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
SELECT DISTINCT (str(?srNotation) AS ?sr) ?dateApplicability ?languageTag ?fileUrl WHERE {{
  ?consolidation a jolux:Consolidation ;
    jolux:dateApplicability ?dateApplicability ;
    jolux:isMemberOf ?cc ;
    jolux:isRealizedBy ?consoExpression .
  ?cc jolux:classifiedByTaxonomyEntry/skos:notation ?srNotation .
  FILTER(datatype(?srNotation) = <https://fedlex.data.admin.ch/vocabulary/notation-type/id-systematique>)
  FILTER(str(?srNotation) = "{sr}")
  ?consoExpression jolux:language ?language ;
    jolux:isEmbodiedBy ?consoManifestation .
  ?consoManifestation jolux:userFormat <https://fedlex.data.admin.ch/vocabulary/user-format/xml> ;
    jolux:isExemplifiedBy ?fileUrl .
  BIND(REPLACE(STR(?language), ".*/", "") AS ?languageTag)
}}
ORDER BY DESC(?dateApplicability)
"""

_ELI_RE = re.compile(r"/(eli/cc/.+?)/\d{8}/[a-z]{2}/xml/")


class ResolvedVersion(BaseModel):
    lang: str
    version_date: date
    file_url: str


def build_query(sr: str) -> str:
    return _QUERY_TEMPLATE.format(sr=sr)


def run_query(client: httpx.Client, sr: str) -> list[ResolvedVersion]:
    response = client.post(
        SPARQL_ENDPOINT,
        data={"query": build_query(sr)},
        headers={"Accept": "application/sparql-results+json"},
    )
    if response.status_code != 200:
        raise RuntimeError(
            f"SPARQL query for SR {sr} failed: HTTP {response.status_code}"
        )
    rows: list[ResolvedVersion] = []
    for binding in response.json()["results"]["bindings"]:
        lang = _LANG_TAG_TO_CODE.get(binding["languageTag"]["value"])
        if lang is None:
            continue  # act published in a language outside the corpus
        rows.append(
            ResolvedVersion(
                lang=lang,
                version_date=date.fromisoformat(binding["dateApplicability"]["value"]),
                file_url=binding["fileUrl"]["value"],
            )
        )
    return rows


def pick_current(
    rows: list[ResolvedVersion], languages: list[str], today: date
) -> dict[str, ResolvedVersion]:
    current: dict[str, ResolvedVersion] = {}
    for row in rows:
        if row.version_date > today:
            continue
        best = current.get(row.lang)
        if best is None or row.version_date > best.version_date:
            current[row.lang] = row
    missing = [lang for lang in languages if lang not in current]
    if missing:
        raise RuntimeError(f"no current consolidation found for languages: {missing}")
    return {lang: current[lang] for lang in languages}


def eli_from_file_url(file_url: str, lang: str) -> str:
    match = _ELI_RE.search(file_url)
    if match is None:
        raise RuntimeError(f"cannot derive ELI from file URL: {file_url}")
    return f"https://www.fedlex.admin.ch/{match.group(1)}/{lang}"
