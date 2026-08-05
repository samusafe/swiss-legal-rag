from datetime import date
from typing import Literal

from pydantic import BaseModel, Field


class SearchRequest(BaseModel):
    q: str = Field(min_length=1)
    lang: Literal["de", "fr", "it"]
    k: int = Field(default=5, ge=1, le=20)


class SearchResult(BaseModel):
    sr: str
    lang: str
    article: str
    part: int | None
    eid: str
    heading: str | None
    context: str | None
    text: str
    eli: str
    act_name: str
    abbrev: str
    version_date: date
    score: float


class SearchResponse(BaseModel):
    results: list[SearchResult]
    took_ms: dict[str, int]
