from retrieval.language import answer_language, detect_language, fts_language

_DE = "Welche Kuendigungsfrist gilt im ersten Dienstjahr nach Schweizer Recht?"
_FR = "Quel delai de conge s applique durant la premiere annee de service?"
_IT = "Quale termine di disdetta si applica nel primo anno di servizio?"
_PT = "O gato correu rapidamente pelo jardim enquanto o sol se punha atras das montanhas."


def test_detect_language_recognizes_german() -> None:
    assert detect_language(_DE) == "de"


def test_detect_language_recognizes_french() -> None:
    assert detect_language(_FR) == "fr"


def test_detect_language_recognizes_italian() -> None:
    assert detect_language(_IT) == "it"


def test_detect_language_recognizes_portuguese() -> None:
    assert detect_language(_PT) == "pt"


def test_detect_language_returns_none_for_gibberish() -> None:
    assert detect_language("asdfghjkl") is None


def test_detect_language_returns_none_for_empty_string() -> None:
    assert detect_language("") is None


def test_answer_language_uses_requested_over_detected() -> None:
    assert answer_language("fr", "de") == "French"


def test_answer_language_falls_back_to_detected() -> None:
    assert answer_language(None, "de") == "German"


def test_answer_language_falls_back_to_english_when_nothing_known() -> None:
    assert answer_language(None, None) == "English"


def test_answer_language_maps_portuguese_detection() -> None:
    assert answer_language(None, "pt") == "Portuguese"


def test_answer_language_falls_back_to_english_for_unknown_code() -> None:
    assert answer_language(None, "xx") == "English"


def test_fts_language_uses_requested_over_detected() -> None:
    assert fts_language("de", "fr") == "de"


def test_fts_language_uses_detected_when_supported() -> None:
    assert fts_language(None, "it") == "it"


def test_fts_language_returns_none_when_detected_unsupported() -> None:
    assert fts_language(None, "pt") is None


def test_fts_language_returns_none_when_nothing_known() -> None:
    assert fts_language(None, None) is None
