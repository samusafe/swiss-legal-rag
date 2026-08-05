from pathlib import Path

import yaml
from pydantic import BaseModel


class Act(BaseModel):
    sr: str
    name: str
    abbrev: str


class CorpusConfig(BaseModel):
    languages: list[str]
    acts: list[Act]


def load_corpus(path: Path) -> CorpusConfig:
    with path.open(encoding="utf-8") as f:
        raw = yaml.safe_load(f)
    return CorpusConfig.model_validate(raw)
