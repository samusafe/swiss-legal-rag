import json
import random
from pathlib import Path

import pytest

from evals.draft import (
    build_chat_request,
    build_gold_row,
    parse_model_output,
    sample_chunks,
)


def _write_chunk_file(path: Path, chunks: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(json.dumps(chunk) for chunk in chunks) + "\n", encoding="utf-8"
    )


def _chunk(
    number: str, article: str, lang: str = "de", collection: str = "SR", jurisdiction: str = "ch"
) -> dict:
    return {
        "jurisdiction": jurisdiction,
        "collection": collection,
        "number": number,
        "lang": lang,
        "article": article,
        "eid": f"art_{article}",
        "text": f"Art. {article}\nSome legal text.",
    }


class TestSampleChunks:
    def test_samples_requested_count_from_matching_lang_only(self, tmp_path):
        _write_chunk_file(
            tmp_path / "ch" / "220" / "de.jsonl",
            [_chunk("220", "1"), _chunk("220", "2"), _chunk("220", "3")],
        )
        _write_chunk_file(
            tmp_path / "ch" / "220" / "fr.jsonl", [_chunk("220", "1", lang="fr")]
        )

        chunks = sample_chunks(tmp_path, "de", count=2, rng=random.Random(0))

        assert len(chunks) == 2
        assert all(chunk["lang"] == "de" for chunk in chunks)

    def test_caps_at_available_pool_size_without_raising(self, tmp_path):
        _write_chunk_file(tmp_path / "ch" / "220" / "de.jsonl", [_chunk("220", "1")])

        chunks = sample_chunks(tmp_path, "de", count=10, rng=random.Random(0))

        assert len(chunks) == 1

    def test_samples_across_multiple_acts(self, tmp_path):
        _write_chunk_file(tmp_path / "ch" / "220" / "de.jsonl", [_chunk("220", "1")])
        _write_chunk_file(tmp_path / "ch" / "210" / "de.jsonl", [_chunk("210", "14")])

        chunks = sample_chunks(tmp_path, "de", count=2, rng=random.Random(0))

        numbers = {chunk["number"] for chunk in chunks}
        assert numbers == {"220", "210"}

    def test_samples_across_jurisdictions(self, tmp_path):
        _write_chunk_file(tmp_path / "ch" / "220" / "de.jsonl", [_chunk("220", "1")])
        _write_chunk_file(
            tmp_path / "sg" / "811.1" / "de.jsonl",
            [_chunk("811.1", "2", collection="sGS", jurisdiction="sg")],
        )

        chunks = sample_chunks(tmp_path, "de", count=2, rng=random.Random(0))

        jurisdictions = {chunk["jurisdiction"] for chunk in chunks}
        assert jurisdictions == {"ch", "sg"}

    def test_raises_when_no_chunks_found_for_lang(self, tmp_path):
        _write_chunk_file(tmp_path / "ch" / "220" / "de.jsonl", [_chunk("220", "1")])

        with pytest.raises(ValueError, match="no chunks"):
            sample_chunks(tmp_path, "fr", count=1, rng=random.Random(0))

    def test_is_deterministic_given_the_same_seeded_rng(self, tmp_path):
        _write_chunk_file(
            tmp_path / "ch" / "220" / "de.jsonl",
            [_chunk("220", str(n)) for n in range(20)],
        )

        first = sample_chunks(tmp_path, "de", count=5, rng=random.Random(42))
        second = sample_chunks(tmp_path, "de", count=5, rng=random.Random(42))

        assert first == second


class TestBuildChatRequest:
    def test_request_targets_given_model_non_streaming_no_think(self):
        chunk = _chunk("220", "335c")

        request = build_chat_request(chunk, model="qwen2.5:3b-instruct")

        assert request["model"] == "qwen2.5:3b-instruct"
        assert request["stream"] is False
        assert request["think"] is False

    def test_request_includes_article_text_in_a_user_message(self):
        chunk = _chunk("220", "335c")
        chunk["text"] = "Art. 335c\nUNIQUE ARTICLE TEXT MARKER"

        request = build_chat_request(chunk, model="qwen2.5:3b-instruct")

        user_contents = [
            m["content"] for m in request["messages"] if m["role"] == "user"
        ]
        assert any("UNIQUE ARTICLE TEXT MARKER" in c for c in user_contents)

    def test_request_mentions_the_chunk_language(self):
        chunk = _chunk("220", "335c", lang="fr")

        request = build_chat_request(chunk, model="qwen2.5:3b-instruct")

        all_content = " ".join(m["content"] for m in request["messages"])
        assert "fr" in all_content.lower()


class TestParseModelOutput:
    def test_parses_valid_json_with_question_and_keywords(self):
        content = json.dumps(
            {"question": "Was regelt Art. 335c?", "keywords": ["Kündigung", "Monat"]}
        )

        parsed = parse_model_output(content)

        assert parsed["question"] == "Was regelt Art. 335c?"
        assert parsed["keywords"] == ["Kündigung", "Monat"]

    def test_raises_on_invalid_json(self):
        with pytest.raises(ValueError):
            parse_model_output("not json")

    def test_raises_when_question_missing(self):
        content = json.dumps({"keywords": ["a", "b"]})
        with pytest.raises(ValueError):
            parse_model_output(content)

    def test_raises_when_keywords_missing(self):
        content = json.dumps({"question": "Q?"})
        with pytest.raises(ValueError):
            parse_model_output(content)

    def test_raises_when_question_is_empty_string(self):
        content = json.dumps({"question": "  ", "keywords": ["a", "b"]})
        with pytest.raises(ValueError):
            parse_model_output(content)

    def test_raises_when_keywords_has_fewer_than_two_entries(self):
        content = json.dumps({"question": "Q?", "keywords": ["only-one"]})
        with pytest.raises(ValueError):
            parse_model_output(content)

    def test_raises_when_keywords_has_more_than_four_entries(self):
        content = json.dumps({"question": "Q?", "keywords": ["a", "b", "c", "d", "e"]})
        with pytest.raises(ValueError):
            parse_model_output(content)

    def test_raises_when_keywords_is_not_a_list_of_strings(self):
        content = json.dumps({"question": "Q?", "keywords": ["a", 2]})
        with pytest.raises(ValueError):
            parse_model_output(content)

    def test_strips_surrounding_markdown_code_fence(self):
        content = "```json\n" + json.dumps(
            {"question": "Q?", "keywords": ["a", "b"]}
        ) + "\n```"

        parsed = parse_model_output(content)

        assert parsed["question"] == "Q?"


class TestBuildGoldRow:
    def test_assembles_row_with_prefilled_fields(self):
        chunk = _chunk("220", "335c", lang="de")
        parsed = {"question": "Was regelt Art. 335c?", "keywords": ["Kündigung", "Monat"]}

        row = build_gold_row(chunk, parsed, index=3)

        assert row == {
            "id": "draft-de-3",
            "lang": "de",
            "question": "Was regelt Art. 335c?",
            "expected_sources": ["SR 220 Art. 335c"],
            "expected_keywords": ["Kündigung", "Monat"],
            "must_refuse": False,
        }

    def test_uses_collection_and_number_for_cantonal_chunks(self):
        chunk = _chunk("811.1", "2", lang="de", collection="sGS")
        parsed = {"question": "Q?", "keywords": ["a", "b"]}

        row = build_gold_row(chunk, parsed, index=1)

        assert row["expected_sources"] == ["sGS 811.1 Art. 2"]

    def test_id_uses_the_chunks_own_language_not_a_passed_in_one(self):
        chunk = _chunk("220", "41", lang="it")
        parsed = {"question": "Q?", "keywords": ["a", "b"]}

        row = build_gold_row(chunk, parsed, index=1)

        assert row["id"] == "draft-it-1"
        assert row["lang"] == "it"
