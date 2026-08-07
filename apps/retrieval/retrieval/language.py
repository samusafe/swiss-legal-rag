"""Question-language detection and the two policies derived from it: which
language the model answers in, and which language Postgres full-text search
uses (or whether it's skipped in favour of dense-only retrieval)."""

from langdetect import DetectorFactory, detect_langs

# Deterministic detection — langdetect's n-gram profiling is seeded per-process.
DetectorFactory.seed = 0

_CONFIDENCE_THRESHOLD = 0.70

# English names for the languages we're likely to see asked in; anything else
# falls back to "English" both for the prompt and (via fts_language) for FTS.
_LANGUAGE_NAMES: dict[str, str] = {
    "en": "English",
    "de": "German",
    "fr": "French",
    "it": "Italian",
    "pt": "Portuguese",
    "es": "Spanish",
    "nl": "Dutch",
}

_FTS_SUPPORTED = {"de", "fr", "it"}


def detect_language(text: str) -> str | None:
    """Best-effort ISO 639-1 code for `text`, or None below the confidence bar.

    Any langdetect failure (empty/too-short/ambiguous text) is treated the same
    as a low-confidence detection: callers fall back to English / dense-only
    retrieval rather than propagating a detection error.
    """
    try:
        candidates = detect_langs(text)
    except Exception:
        return None
    if not candidates:
        return None
    top = candidates[0]
    if top.prob >= _CONFIDENCE_THRESHOLD:
        return top.lang
    return None


def answer_language_code(requested: str | None, detected: str | None) -> str:
    """ISO 639-1 code of the language to answer in — used to resolve citations
    against the source matching the answer's language (see `citations.py`)."""
    return requested or detected or "en"


def answer_language(requested: str | None, detected: str | None) -> str:
    """English name of the language to answer in, for the system prompt."""
    return _LANGUAGE_NAMES.get(answer_language_code(requested, detected), "English")


def fts_language(requested: str | None, detected: str | None) -> str | None:
    """FTS language to use, or None to skip the FTS arm (dense-only + rerank)."""
    if requested is not None:
        return requested
    if detected in _FTS_SUPPORTED:
        return detected
    return None
