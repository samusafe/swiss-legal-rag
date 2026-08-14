from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, computed_field, field_validator

CANTON_CODES = frozenset({
    "AG", "AI", "AR", "BE", "BL", "BS", "FR", "GE", "GL", "GR", "JU", "LU", "NE", "NW",
    "OW", "SG", "SH", "SO", "SZ", "TG", "TI", "UR", "VD", "VS", "ZG", "ZH",
})


def _check_canton(v: str | None) -> str | None:
    if v is not None and v not in CANTON_CODES:
        raise ValueError(f"unknown canton code: {v}")
    return v


class SearchRequest(BaseModel):
    q: str = Field(min_length=1, max_length=2000)
    lang: Literal["de", "fr", "it"]
    k: int = Field(default=5, ge=1, le=20)
    canton: str | None = None

    @field_validator("canton")
    @classmethod
    def _known_canton(cls, v: str | None) -> str | None:
        return _check_canton(v)


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    # Optional: omitted or null lets the server detect the question's language.
    lang: Literal["de", "fr", "it"] | None = None
    k: int = Field(default=5, ge=1, le=20)
    canton: str | None = None

    @field_validator("canton")
    @classmethod
    def _known_canton(cls, v: str | None) -> str | None:
        return _check_canton(v)


class SearchResult(BaseModel):
    jurisdiction: str
    collection: str
    number: str
    lang: str
    article: str
    part: int | None
    eid: str
    heading: str | None
    context: str | None
    text: str
    source_url: str
    act_name: str
    abbrev: str
    version_date: date
    score: float

    @computed_field  # type: ignore[prop-decorator]
    @property
    def citation_label(self) -> str:
        return f"{self.collection} {self.number} Art. {self.article}"


class SearchResponse(BaseModel):
    results: list[SearchResult]
    took_ms: dict[str, int]


class ArticleResponse(BaseModel):
    jurisdiction: str
    collection: str
    number: str
    article: str
    lang: str
    heading: str | None
    act_name: str
    abbrev: str
    source_url: str
    version_date: date
    texts: list[str]
    available_langs: list[str]

    @computed_field  # type: ignore[prop-decorator]
    @property
    def citation_label(self) -> str:
        return f"{self.collection} {self.number} Art. {self.article}"
