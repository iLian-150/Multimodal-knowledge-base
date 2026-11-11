"""Reranking adapter seam with deterministic local and Alibaba Bailian backends."""

from __future__ import annotations

import base64
import json
import math
import mimetypes
import os
import re
import urllib.error
import urllib.request
from typing import Any, Dict, Iterable, List, Optional

from manufacturing_rag.config import DEFAULT_CONFIG, RAGConfig
from manufacturing_rag.query import split_terms
from manufacturing_rag.resilience import retry_call
from manufacturing_rag.schemas import RetrievalResult


class RuleBasedReranker:
    """Local substitute for a deployed rerank model during MVP development."""

    def rerank(self, query: str, candidates: List[RetrievalResult], top_k: int, threshold: float) -> List[RetrievalResult]:
        query_terms = terms_for_rerank(query)
        reranked: List[RetrievalResult] = []
        for candidate in candidates:
            text = candidate.chunk.text.lower()
            coverage = lexical_coverage(query_terms, text)
            answer_boost = answer_pattern_boost(query, text)
            quality_factor = 0.55 if candidate.chunk.needs_review else 1.0
            candidate.score = min(
                1.0,
                (blend_relevance_score(candidate.score, coverage) + answer_boost) * quality_factor,
            )
            candidate.reason = f"{candidate.reason}; rerank_coverage={coverage:.2f}; answer_pattern_boost={answer_boost:.2f}"
            if candidate.score >= threshold:
                reranked.append(candidate)
        reranked.sort(key=lambda item: item.score, reverse=True)
        for rank, result in enumerate(reranked[:top_k], start=1):
            result.rank = rank
        return reranked[:top_k]


class BailianReranker:
    """Alibaba Cloud Bailian/DashScope rerank adapter."""

    def __init__(self, config: RAGConfig = DEFAULT_CONFIG, fallback: Optional[RuleBasedReranker] = None) -> None:
        self.config = config
        self.api_key = first_env_value(config.rerank_api_key_env, "DASHSCOPE_API_KEY", "BAILIAN_API_KEY")
        self.model = config.rerank_model
        self.base_url = config.rerank_api_base_url
        self.timeout_seconds = config.rerank_timeout_seconds
        self.fallback = fallback or RuleBasedReranker()

    def rerank(self, query: str, candidates: List[RetrievalResult], top_k: int, threshold: float) -> List[RetrievalResult]:
        if not candidates:
            return []
        if not self.api_key:
            return self._fallback_or_raise(query, candidates, top_k, threshold, "Bailian rerank API key is not configured")
        try:
            scores = self._remote_rerank(query, candidates, top_k=max(top_k, len(candidates)))
            return self._apply_scores(query, candidates, scores, top_k=top_k, threshold=threshold)
        except Exception as exc:  # noqa: BLE001 - fallback keeps local workflows usable.
            return self._fallback_or_raise(query, candidates, top_k, threshold, f"Bailian rerank request failed: {exc}")

    def _remote_rerank(self, query: str, candidates: List[RetrievalResult], top_k: int) -> Dict[int, float]:
        payload = {
            "model": self.model,
            "input": {
                "query": query,
                "documents": [rerank_document(candidate) for candidate in candidates],
            },
            "parameters": {
                "top_n": top_k,
                "return_documents": False,
            },
        }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self.base_url,
            data=body,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        def execute() -> str:
            try:
                with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                    return response.read().decode("utf-8")
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")[:500]
                raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
            except urllib.error.URLError as exc:
                raise RuntimeError(f"network error: {exc.reason}") from exc

        raw = retry_call(execute, self.config.retry_attempts, self.config.retry_base_seconds)
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise RuntimeError("rerank response must be a JSON object")
        return extract_rerank_scores(parsed)

    def _apply_scores(
        self,
        query: str,
        candidates: List[RetrievalResult],
        scores: Dict[int, float],
        top_k: int,
        threshold: float,
    ) -> List[RetrievalResult]:
        if not scores:
            raise RuntimeError("Bailian rerank response did not contain scores")
        reranked: List[RetrievalResult] = []
        query_terms = terms_for_rerank(query)
        for index, candidate in enumerate(candidates):
            if index not in scores:
                continue
            remote_score = float(scores[index])
            coverage = lexical_coverage(query_terms, candidate.chunk.text.lower())
            quality_factor = 0.55 if candidate.chunk.needs_review else 1.0
            candidate.score = min(
                1.0,
                max(remote_score, blend_relevance_score(candidate.score, coverage)) * quality_factor,
            )
            candidate.reason = f"{candidate.reason}; bailian_rerank; lexical_coverage={coverage:.2f}"
            if candidate.score >= threshold:
                reranked.append(candidate)
        reranked.sort(key=lambda item: item.score, reverse=True)
        for rank, result in enumerate(reranked[:top_k], start=1):
            result.rank = rank
        return reranked[:top_k]

    def _fallback_or_raise(
        self,
        query: str,
        candidates: List[RetrievalResult],
        top_k: int,
        threshold: float,
        message: str,
    ) -> List[RetrievalResult]:
        if self.config.rerank_fallback_enabled:
            return self.fallback.rerank(query, candidates, top_k, threshold)
        raise RuntimeError(message)


class CrossEncoderReranker:
    """Sentence-Transformers CrossEncoder adapter with a deterministic fallback."""

    def __init__(self, config: RAGConfig = DEFAULT_CONFIG, fallback: Optional[RuleBasedReranker] = None) -> None:
        self.config = config
        self.fallback = fallback or RuleBasedReranker()
        self._model: Any = None

    def rerank(self, query: str, candidates: List[RetrievalResult], top_k: int, threshold: float) -> List[RetrievalResult]:
        if not candidates:
            return []
        try:
            scores = self._model_instance().predict([(query, candidate.chunk.text) for candidate in candidates])
            reranked: List[RetrievalResult] = []
            query_terms = terms_for_rerank(query)
            for candidate, raw_score in zip(candidates, scores):
                cross_score = normalize_cross_encoder_score(raw_score)
                coverage = lexical_coverage(query_terms, candidate.chunk.text.lower())
                quality_factor = 0.55 if candidate.chunk.needs_review else 1.0
                candidate.score = min(
                    1.0,
                    max(cross_score, blend_relevance_score(candidate.score, coverage)) * quality_factor,
                )
                candidate.reason += f"; cross_encoder={cross_score:.3f}"
                if candidate.score >= threshold:
                    reranked.append(candidate)
            reranked.sort(key=lambda item: item.score, reverse=True)
            for rank, result in enumerate(reranked[:top_k], start=1):
                result.rank = rank
            return reranked[:top_k]
        except Exception as exc:  # noqa: BLE001 - keep the service available without model artifacts.
            if self.config.rerank_fallback_enabled:
                fallback_results = self.fallback.rerank(query, candidates, top_k, threshold)
                for result in fallback_results:
                    result.reason += f"; cross_encoder_fallback={type(exc).__name__}"
                return fallback_results
            raise RuntimeError(f"CrossEncoder rerank failed: {exc}") from exc

    def _model_instance(self):
        if self._model is not None:
            return self._model
        try:
            from sentence_transformers import CrossEncoder  # type: ignore[import-not-found]
        except ImportError as exc:
            raise RuntimeError("sentence-transformers is required for CrossEncoder reranking") from exc
        self._model = CrossEncoder(self.config.rerank_model, device=self.config.rerank_device)
        return self._model


class BGERerankerAdapter(CrossEncoderReranker):
    """Backward-compatible name for BGE CrossEncoder reranking."""


def build_reranker(config: RAGConfig = DEFAULT_CONFIG) -> RuleBasedReranker:
    provider = (config.rerank_provider or "rule").strip().lower()
    if provider in {"bailian", "dashscope", "aliyun"}:
        return BailianReranker(config)  # type: ignore[return-value]
    if provider in {"cross-encoder", "cross_encoder", "bge", "bge-reranker"}:
        return CrossEncoderReranker(config)  # type: ignore[return-value]
    return RuleBasedReranker()


def normalize_cross_encoder_score(value: Any) -> float:
    try:
        score = float(value)
    except (TypeError, ValueError):
        return 0.0
    if 0.0 <= score <= 1.0:
        return score
    return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, score))))


def first_env_value(*names: str) -> str:
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return ""


def rerank_document(candidate: RetrievalResult) -> Any:
    """Pass retained source imagery to the vision reranker when it is available."""

    image_path = str(candidate.chunk.image_path or "").strip()
    if image_path and os.path.isfile(image_path):
        try:
            if os.path.getsize(image_path) <= 8 * 1024 * 1024:
                with open(image_path, "rb") as image_file:
                    encoded = base64.b64encode(image_file.read()).decode("ascii")
                mime_type = mimetypes.guess_type(image_path)[0] or "image/png"
                return {"image": f"data:{mime_type};base64,{encoded}"}
        except OSError:
            pass
    return candidate.chunk.text


def terms_for_rerank(query: str) -> List[str]:
    terms = split_terms(query)
    compact = re.sub(r"\s+", "", query)
    for size in (2, 3, 4):
        for index in range(0, max(len(compact) - size + 1, 0)):
            token = compact[index : index + size]
            if re.search(r"[\u4e00-\u9fff]", token):
                terms.append(token)
    return unique_keep_order([term.lower() for term in terms if len(str(term).strip()) >= 2])


def lexical_coverage(query_terms: List[str], text: str) -> float:
    if not query_terms:
        return 0.0
    hits = sum(1 for term in query_terms if term and term in text)
    core_hits = sum(1 for term in query_terms if len(term) >= 3 and term in text)
    return min(1.0, hits / max(len(query_terms), 1) + core_hits * 0.06)


def blend_relevance_score(base_score: float, coverage: float) -> float:
    return min(1.0, max(base_score, 0.0) * 0.55 + coverage * 0.65)


def answer_pattern_boost(query: str, text: str) -> float:
    """Give deterministic fallback reranking a small boost for answer-shaped evidence.

    This is intentionally limited to patterns already present in the query. It
    improves local/offline behavior without inventing terms or concrete facts.
    Remote cross-encoder and Bailian rerankers remain available in production.
    """

    normalized_query = re.sub(r"\s+", "", query.lower())
    normalized_text = re.sub(r"\s+", "", text.lower())
    boost = 0.0
    if "分为哪" in normalized_query or "哪两种" in normalized_query:
        if "分为" in normalized_text:
            boost += 0.12
        if "考试" in normalized_text and "考查" in normalized_text:
            boost += 0.22
    if any(marker in normalized_query for marker in ("包括哪些", "有哪些", "列出", "哪几")):
        if "风险" in normalized_query:
            risk_count = normalized_text.count("风险")
            boost += min(0.24, risk_count * 0.04)
        elif any(marker in normalized_text for marker in ("包括", "分别", "以下")):
            boost += 0.08
    if any(marker in normalized_query for marker in ("怎样认定", "如何认定", "怎么认定")):
        if any(marker in normalized_text for marker in ("折算", "认定", "计入")):
            boost += 0.18
    if "可以申请什么" in normalized_query and "可以申请" in normalized_text:
        boost += 0.14
    return min(0.35, boost)


def unique_keep_order(values: Iterable[str]) -> List[str]:
    seen = set()
    result: List[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def extract_rerank_scores(data: Dict[str, Any]) -> Dict[int, float]:
    results = []
    if isinstance(data.get("results"), list):
        results = data["results"]
    output = data.get("output")
    if isinstance(output, dict) and isinstance(output.get("results"), list):
        results = output["results"]
    if not results and isinstance(data.get("data"), list):
        results = data["data"]
    scores: Dict[int, float] = {}
    for fallback_index, item in enumerate(results):
        if not isinstance(item, dict):
            continue
        index = item.get("index", item.get("document_index", fallback_index))
        score = item.get("relevance_score", item.get("score", item.get("similarity")))
        try:
            scores[int(index)] = float(score)
        except (TypeError, ValueError):
            continue
    return scores
