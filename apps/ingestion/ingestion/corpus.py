from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, model_validator


class Act(BaseModel):
    number: str
    name: str
    abbrev: str


class Jurisdiction(BaseModel):
    code: str
    source: Literal["fedlex", "lexwork"]
    collection: str
    base_url: str | None = None
    languages: list[str]
    acts: list[Act]

    @model_validator(mode="after")
    def _lexwork_needs_base_url(self) -> "Jurisdiction":
        if self.source == "lexwork" and not self.base_url:
            raise ValueError(f"jurisdiction {self.code}: lexwork source requires base_url")
        return self


class CorpusConfig(BaseModel):
    jurisdictions: list[Jurisdiction]


def load_corpus(path: Path) -> CorpusConfig:
    with path.open(encoding="utf-8") as fh:
        return CorpusConfig.model_validate(yaml.safe_load(fh))
