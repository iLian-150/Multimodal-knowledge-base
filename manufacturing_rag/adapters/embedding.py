"""Embedding adapter seam with deterministic local and Alibaba Bailian backends."""

from __future__ import annotations

import base64
import hashlib
import json
import math
import mimetypes
import os
import urllib.error
import urllib.request
from typing import Any, Dict, Iterable, List, Optional, Protocol, Sequence

from manufacturing_rag.config import DEFAULT_CONFIG, RAGConfig
from manufacturing_rag.query import split_terms
from manufacturing_rag.resilience import retry_call


class EmbeddingAdapter(Protocol):
    def embed_text(self, text: str) -> List[float]:
        ...


class HashEmbeddingAdapter:
    """Deterministic token-hash vectors for local tests and offline scaffolding."""

    def __init__(self, config: RAGConfig = DEFAULT_CONFIG) -> None:
        self.dimensions = config.embedding_dimensions

    def embed_text(self, text: str) -> List[float]:
        vector = [0.0 for _ in range(self.dimensions)]
        terms = split_terms(text)
        if not terms:
            return vector
        for term in terms:
            digest = hashlib.sha256(term.encode("utf-8")).digest()
            index = int.from_bytes(digest[:4], "big") % self.dimensions
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            vector[index] += sign
        norm = math.sqrt(sum(value * value for value in vector)) or 1.0
        return [value / norm for value in vector]

    def embed_sparse(self, text: str) -> Dict[str, float]:
        terms = split_terms(text)
        if not terms:
            return {}
        weights: Dict[str, float] = {}
        for term in terms:
            weights[term] = weights.get(term, 0.0) + 1.0
        norm = math.sqrt(sum(value * value for value in weights.values())) or 1.0
        return {key: value / norm for key, value in weights.items()}


class BGEM3EmbeddingAdapter:
    """Local BGE-M3 dense and lexical-weight sparse embeddings with lazy loading."""

    def __init__(self, config: RAGConfig = DEFAULT_CONFIG, fallback: Optional[EmbeddingAdapter] = None) -> None:
        self.config = config
        self.fallback = fallback or HashEmbeddingAdapter(config)
        self._model: Any = None
        self._backend = ""

    def embed_text(self, text: str) -> List[float]:
        try:
            model = self._load_model()
            if self._backend == "flagembedding":
                output = model.encode([text], return_dense=True, return_sparse=True, return_colbert_vecs=False)
                return [float(value) for value in output["dense_vecs"][0]]
            vector = model.encode(text, normalize_embeddings=True)
            return [float(value) for value in vector.tolist()]
        except Exception as exc:  # noqa: BLE001 - explicit offline fallback.
            if self.config.embedding_fallback_enabled:
                return self.fallback.embed_text(text)
            raise RuntimeError(f"BGE-M3 dense embedding failed: {exc}") from exc

    def embed_sparse(self, text: str) -> Dict[str, float]:
        try:
            model = self._load_model()
            if self._backend != "flagembedding":
                return getattr(self.fallback, "embed_sparse")(text)
            output = model.encode([text], return_dense=False, return_sparse=True, return_colbert_vecs=False)
            weights = output["lexical_weights"][0]
            return {str(key): float(value) for key, value in weights.items()}
        except Exception as exc:  # noqa: BLE001 - explicit offline fallback.
            if self.config.embedding_fallback_enabled:
                return getattr(self.fallback, "embed_sparse")(text)
            raise RuntimeError(f"BGE-M3 sparse embedding failed: {exc}") from exc

    def _load_model(self):
        if self._model is not None:
            return self._model
        try:
            from FlagEmbedding import BGEM3FlagModel  # type: ignore[import-not-found]

            self._model = BGEM3FlagModel(
                self.config.embedding_model,
                use_fp16=self.config.embedding_device.lower() != "cpu",
            )
            self._backend = "flagembedding"
            return self._model
        except ImportError:
            try:
                from sentence_transformers import SentenceTransformer  # type: ignore[import-not-found]
            except ImportError as exc:
                raise RuntimeError("FlagEmbedding or sentence-transformers is required for BGE-M3") from exc
            self._model = SentenceTransformer(self.config.embedding_model, device=self.config.embedding_device)
            self._backend = "sentence-transformers"
            return self._model


class BailianEmbeddingAdapter:
    """Alibaba Cloud Bailian/DashScope embedding adapter.

    Defaults to the OpenAI-compatible embeddings endpoint. If your Bailian model
    uses a DashScope task endpoint, set BAILIAN_EMBEDDING_REQUEST_FORMAT to
    "dashscope_text" and override BAILIAN_EMBEDDING_API_BASE_URL accordingly.
    """

    def __init__(self, config: RAGConfig = DEFAULT_CONFIG, fallback: Optional[EmbeddingAdapter] = None) -> None:
        self.config = config
        self.api_key = first_env_value(config.embedding_api_key_env, "DASHSCOPE_API_KEY", "BAILIAN_API_KEY")
        self.model = config.embedding_model
        self.base_url = config.embedding_api_base_url
        self.request_format = config.embedding_request_format
        self.timeout_seconds = config.embedding_timeout_seconds
        self.fallback = fallback or HashEmbeddingAdapter(config)

    def embed_text(self, text: str) -> List[float]:
        if not self.api_key:
            if self.config.embedding_fallback_enabled:
                return self.fallback.embed_text(text)
            raise RuntimeError("Bailian embedding API key is not configured")
        try:
            return self._remote_embed(text)
        except Exception as exc:  # noqa: BLE001 - fallback keeps offline workflows usable.
            if self.config.embedding_fallback_enabled:
                return self.fallback.embed_text(text)
            raise RuntimeError(f"Bailian embedding request failed: {exc}") from exc

    def embed_texts(self, texts: Sequence[str]) -> List[List[float]]:
        """Embed documents in bounded batches to keep PDF ingestion practical."""

        values = [str(text) for text in texts]
        if not values:
            return []
        if not self.api_key:
            if self.config.embedding_fallback_enabled:
                return [self.fallback.embed_text(text) for text in values]
            raise RuntimeError("Bailian embedding API key is not configured")
        vectors: List[List[float]] = []
        batch_size = max(1, int(self.config.embedding_batch_size))
        for start in range(0, len(values), batch_size):
            batch = values[start : start + batch_size]
            try:
                vectors.extend(self._remote_embed_batch(batch))
            except Exception as exc:  # noqa: BLE001 - preserve the configured local fallback.
                if not self.config.embedding_fallback_enabled:
                    raise RuntimeError(f"Bailian embedding batch request failed: {exc}") from exc
                vectors.extend(self.fallback.embed_text(text) for text in batch)
        return vectors

    def embed_chunk(self, chunk: Any) -> List[float]:
        """Fuse a retained image with its OCR/description text when available."""

        image_path = str(getattr(chunk, "image_path", "") or "").strip()
        if self.request_format != "dashscope_multimodal" or not image_path or not os.path.isfile(image_path):
            return self.embed_text(str(getattr(chunk, "text", "")))
        try:
            with open(image_path, "rb") as image_file:
                image_bytes = image_file.read()
            mime_type = mimetypes.guess_type(image_path)[0] or "image/png"
            data_uri = f"data:{mime_type};base64,{base64.b64encode(image_bytes).decode('ascii')}"
            payload = {
                "model": self.model,
                "input": {"contents": [{"text": str(getattr(chunk, "text", ""))}, {"image": data_uri}]},
                "parameters": {"dimension": self.config.embedding_dimensions, "enable_fusion": True},
            }
            vector = extract_embedding_vector(self._post_json(payload))
            if not vector:
                raise RuntimeError("Bailian multimodal response did not contain a fused vector")
            return vector
        except Exception as exc:  # noqa: BLE001 - only configured fallback may replace cloud vectors.
            if self.config.embedding_fallback_enabled:
                return self.fallback.embed_text(str(getattr(chunk, "text", "")))
            raise RuntimeError(f"Bailian multimodal embedding failed: {exc}") from exc

    def _remote_embed(self, text: str) -> List[float]:
        payload = self._build_payload(text)
        data = self._post_json(payload)
        vector = extract_embedding_vector(data)
        if not vector:
            raise RuntimeError("Bailian embedding response did not contain an embedding vector")
        return [float(value) for value in vector]

    def _remote_embed_batch(self, texts: Sequence[str]) -> List[List[float]]:
        data = self._post_json(self._build_batch_payload(texts))
        vectors = extract_embedding_vectors(data)
        if len(vectors) != len(texts) or any(not vector for vector in vectors):
            raise RuntimeError("Bailian embedding response did not contain one vector per input")
        return vectors

    def _build_payload(self, text: str) -> Dict[str, Any]:
        if self.request_format == "dashscope_multimodal":
            return {
                "model": self.model,
                "input": {"contents": [{"text": text}]},
                "parameters": {"dimension": self.config.embedding_dimensions},
            }
        if self.request_format == "dashscope_text":
            return {"model": self.model, "input": {"texts": [text]}}
        return {"model": self.model, "input": text}

    def _build_batch_payload(self, texts: Sequence[str]) -> Dict[str, Any]:
        if self.request_format == "dashscope_multimodal":
            return {
                "model": self.model,
                "input": {"contents": [{"text": text} for text in texts]},
                "parameters": {"dimension": self.config.embedding_dimensions},
            }
        if self.request_format == "dashscope_text":
            return {"model": self.model, "input": {"texts": list(texts)}}
        return {"model": self.model, "input": list(texts)}

    def _post_json(self, payload: Dict[str, Any]) -> Dict[str, Any]:
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
            raise RuntimeError("embedding response must be a JSON object")
        return parsed



class DimensionCheckingEmbeddingAdapter:
    """Wrap an embedding adapter and ensure Milvus schema dimensions match."""

    def __init__(self, adapter: EmbeddingAdapter, expected_dimensions: int) -> None:
        self.adapter = adapter
        self.expected_dimensions = expected_dimensions

    def embed_text(self, text: str) -> List[float]:
        vector = self.adapter.embed_text(text)
        if self.expected_dimensions and len(vector) != self.expected_dimensions:
            raise RuntimeError(
                f"embedding dimension mismatch: got {len(vector)}, expected {self.expected_dimensions}; "
                "update RAG_EMBEDDING_DIMENSIONS and rebuild the vector collection"
            )
        return vector

    def embed_chunk(self, chunk: Any) -> List[float]:
        method = getattr(self.adapter, "embed_chunk", None)
        vector = method(chunk) if callable(method) else self.adapter.embed_text(str(getattr(chunk, "text", "")))
        if self.expected_dimensions and len(vector) != self.expected_dimensions:
            raise RuntimeError(
                f"embedding dimension mismatch: got {len(vector)}, expected {self.expected_dimensions}; "
                "update RAG_EMBEDDING_DIMENSIONS and rebuild the vector collection"
            )
        return [float(value) for value in vector]

    def embed_texts(self, texts: Sequence[str]) -> List[List[float]]:
        method = getattr(self.adapter, "embed_texts", None)
        vectors = method(texts) if callable(method) else [self.embed_text(text) for text in texts]
        checked: List[List[float]] = []
        for vector in vectors:
            if self.expected_dimensions and len(vector) != self.expected_dimensions:
                raise RuntimeError(
                    f"embedding dimension mismatch: got {len(vector)}, expected {self.expected_dimensions}; "
                    "update RAG_EMBEDDING_DIMENSIONS and rebuild the vector collection"
                )
            checked.append([float(value) for value in vector])
        return checked

    def embed_sparse(self, text: str) -> Dict[str, float]:
        method = getattr(self.adapter, "embed_sparse", None)
        return method(text) if callable(method) else {}


class RedisCachingEmbeddingAdapter:
    """Cache hot dense and sparse vectors in Redis to reduce repeated BGE-M3 work."""

    def __init__(self, adapter: EmbeddingAdapter, config: RAGConfig) -> None:
        self.adapter = adapter
        self.config = config
        self._client: Any = None
        self._disabled = False

    def embed_text(self, text: str) -> List[float]:
        key = self._key("dense", text)
        cached = self._get(key)
        if isinstance(cached, list):
            return [float(value) for value in cached]
        vector = self.adapter.embed_text(text)
        self._set(key, vector)
        return vector

    def embed_texts(self, texts: Sequence[str]) -> List[List[float]]:
        method = getattr(self.adapter, "embed_texts", None)
        return method(texts) if callable(method) else [self.embed_text(text) for text in texts]

    def embed_chunk(self, chunk: Any) -> List[float]:
        method = getattr(self.adapter, "embed_chunk", None)
        return method(chunk) if callable(method) else self.embed_text(str(getattr(chunk, "text", "")))

    def embed_sparse(self, text: str) -> Dict[str, float]:
        key = self._key("sparse", text)
        cached = self._get(key)
        if isinstance(cached, dict):
            return {str(name): float(value) for name, value in cached.items()}
        method = getattr(self.adapter, "embed_sparse", None)
        values = method(text) if callable(method) else {}
        self._set(key, values)
        return values

    def _key(self, kind: str, text: str) -> str:
        digest = hashlib.sha256(f"{self.config.embedding_model}:{text}".encode("utf-8")).hexdigest()
        return f"education-rag:embedding:{kind}:{digest}"

    def _get(self, key: str) -> Any:
        client = self._redis()
        if client is None:
            return None
        try:
            raw = client.get(key)
            return json.loads(raw) if raw else None
        except Exception:  # noqa: BLE001 - cache is never required for correctness.
            return None

    def _set(self, key: str, value: Any) -> None:
        client = self._redis()
        if client is None:
            return
        try:
            client.setex(key, self.config.redis_cache_ttl_seconds, json.dumps(value, ensure_ascii=False))
        except Exception:  # noqa: BLE001
            return

    def _redis(self):
        if self._disabled:
            return None
        if self._client is not None:
            return self._client
        try:
            import redis  # type: ignore[import-not-found]

            self._client = redis.Redis.from_url(self.config.redis_url, decode_responses=True, socket_timeout=2)
            return self._client
        except Exception:  # noqa: BLE001
            self._disabled = True
            return None


def build_embedding_adapter(config: RAGConfig = DEFAULT_CONFIG, check_dimensions: bool = False) -> EmbeddingAdapter:
    provider = (config.embedding_provider or "hash").strip().lower()
    if provider in {"bge-m3", "bge_m3", "bge"}:
        adapter: EmbeddingAdapter = BGEM3EmbeddingAdapter(config)
    elif provider in {"bailian", "dashscope", "aliyun"}:
        adapter: EmbeddingAdapter = BailianEmbeddingAdapter(config)
    else:
        adapter = HashEmbeddingAdapter(config)
    if config.redis_enabled:
        adapter = RedisCachingEmbeddingAdapter(adapter, config)
    if check_dimensions:
        return DimensionCheckingEmbeddingAdapter(adapter, config.embedding_dimensions)
    return adapter


def cosine_similarity(left: Sequence[float], right: Sequence[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    numerator = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(a * a for a in left)) or 1.0
    right_norm = math.sqrt(sum(b * b for b in right)) or 1.0
    return max(0.0, numerator / (left_norm * right_norm))


def first_env_value(*names: str) -> str:
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return ""


def extract_embedding_vector(data: Dict[str, Any]) -> List[float]:
    candidates: List[Any] = []
    candidates.append(data.get("embedding"))
    if isinstance(data.get("data"), list) and data["data"]:
        candidates.append(data["data"][0].get("embedding") if isinstance(data["data"][0], dict) else None)
    output = data.get("output")
    if isinstance(output, dict):
        embeddings = output.get("embeddings")
        if isinstance(embeddings, list) and embeddings:
            first = embeddings[0]
            candidates.append(first.get("embedding") if isinstance(first, dict) else first)
        candidates.append(output.get("embedding"))
    for candidate in candidates:
        vector = normalize_vector(candidate)
        if vector:
            return vector
    return []


def extract_embedding_vectors(data: Dict[str, Any]) -> List[List[float]]:
    """Normalize OpenAI-compatible and DashScope batch embedding responses."""

    rows: List[Any] = []
    if isinstance(data.get("data"), list):
        rows = sorted(
            [item for item in data["data"] if isinstance(item, dict)],
            key=lambda item: int(item.get("index", 0) or 0),
        )
        vectors = [normalize_vector(item.get("embedding")) for item in rows]
        if vectors:
            return vectors
    output = data.get("output")
    if isinstance(output, dict) and isinstance(output.get("embeddings"), list):
        embeddings = output["embeddings"]
        if all(isinstance(item, dict) for item in embeddings):
            embeddings = sorted(embeddings, key=lambda item: int(item.get("index", 0) or 0))
        for item in embeddings:
            candidate = item.get("embedding") if isinstance(item, dict) else item
            rows.append(candidate)
    return [normalize_vector(item) for item in rows]


def normalize_vector(value: Any) -> List[float]:
    if not isinstance(value, list):
        return []
    vector: List[float] = []
    for item in value:
        try:
            vector.append(float(item))
        except (TypeError, ValueError):
            return []
    return vector
