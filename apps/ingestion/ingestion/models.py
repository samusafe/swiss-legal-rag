from datetime import date
from pathlib import Path

from pydantic import BaseModel


class ManifestEntry(BaseModel):
    sr: str
    lang: str
    act_name: str
    abbrev: str
    version_date: date
    eli: str
    file_url: str


class Manifest(BaseModel):
    entries: list[ManifestEntry]

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.model_dump_json(indent=2), encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> "Manifest":
        return cls.model_validate_json(path.read_text(encoding="utf-8"))
