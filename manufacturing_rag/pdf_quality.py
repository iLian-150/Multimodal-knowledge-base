"""Heuristics for deciding whether extracted PDF text is safe to index."""

from __future__ import annotations

import re
from typing import List

from manufacturing_rag.schemas import DocumentChunk


def pdf_chunks_are_searchable(chunks: List[DocumentChunk]) -> bool:
    text = "\n".join(chunk.text for chunk in chunks).strip()
    if len(text) < 20:
        return False
    if chunks_have_unusable_pdf_text(chunks):
        return False
    if looks_like_spaced_pdf_garble(text):
        return False
    meaningful = sum(1 for char in text if "\u4e00" <= char <= "\u9fff" or char.isascii() and char.isalnum())
    replacement = text.count("�") + text.count("?")
    return meaningful / max(len(text), 1) >= 0.35 and replacement / max(len(text), 1) < 0.08


def chunks_have_unusable_pdf_text(chunks: List[DocumentChunk]) -> bool:
    """Detect a bad page even when good pages hide it in a document average."""

    return any(suspicious_pdf_text(chunk.text) for chunk in chunks)


def suspicious_pdf_text(text: str) -> bool:
    value = str(text or "").strip()
    if len(value) < 40:
        return False
    if looks_like_spaced_pdf_garble(value):
        return True
    meaningful = sum(1 for char in value if "\u4e00" <= char <= "\u9fff" or char.isascii() and char.isalnum())
    replacement = value.count("�") + value.count("?")
    return meaningful / max(len(value), 1) < 0.35 or replacement / max(len(value), 1) >= 0.08


def looks_like_spaced_pdf_garble(text: str) -> bool:
    mojibake_chars = sum(1 for char in text if "\u00c0" <= char <= "\u00ff" or char == "�")
    if mojibake_chars / max(len(text), 1) >= 0.03:
        return True
    tokens = [token for token in re.split(r"\s+", text.strip()) if token]
    if len(tokens) < 30:
        return False
    single_char_tokens = sum(1 for token in tokens if len(token) == 1)
    average_token_length = sum(len(token) for token in tokens) / len(tokens)
    cjk_chars = sum(1 for char in text if "\u4e00" <= char <= "\u9fff")
    cjk_single_tokens = sum(1 for token in tokens if len(token) == 1 and "\u4e00" <= token <= "\u9fff")
    if average_token_length <= 1.8 and single_char_tokens / len(tokens) >= 0.62:
        return True
    return cjk_chars >= 20 and cjk_single_tokens / max(cjk_chars, 1) >= 0.65
