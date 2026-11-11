"""BERT intent classification and LangChain-agent adaptive query optimization."""

from __future__ import annotations

import json
import os
import re
from dataclasses import replace
from pathlib import Path
from typing import Any, Optional

from manufacturing_rag.config import DEFAULT_CONFIG, RAGConfig
from manufacturing_rag.query import unique_keep_order
from manufacturing_rag.schemas import EntityExtractionResult, IntentResult


class AdaptiveQueryOptimizer:
    """Route simple questions directly and enhance complex or ambiguous questions."""

    def __init__(self, fallback: Any, config: RAGConfig = DEFAULT_CONFIG) -> None:
        self.fallback = fallback
        self.config = config
        self._bert: Any = None
        self._bert_unavailable = False
        self._agent: Any = None
        self._agent_unavailable = False

    def classify_intent(self, question: str, conversation_context: str = "") -> IntentResult:
        try:
            local = self.fallback.classify_intent(question, conversation_context=conversation_context)
        except TypeError:
            # Keep compatibility with custom local classifiers that only accept
            # the current user message.
            local = self.fallback.classify_intent(question)
        difficulty = assess_query_difficulty(question)
        strategy = "direct" if difficulty == "simple" else "rewrite_decompose_enhance"
        if self.config.query_classifier_provider != "bert" or not local.allowed:
            return replace(local, difficulty=difficulty, query_strategy=strategy)
        prediction = self._bert_prediction(question)
        if not prediction:
            return replace(local, difficulty=difficulty, query_strategy=strategy)
        label = normalize_bert_label(str(prediction.get("label") or ""))
        category = label if label in ALLOWED_INTENTS else local.category
        confidence = max(local.confidence, float(prediction.get("score") or 0.0))
        allowed = category not in {"malicious_attack", "unauthorized_query", "empty"}
        return IntentResult(
            category=category,
            allowed=allowed,
            confidence=min(1.0, confidence),
            reason=f"BERT意图分类；{local.reason}",
            difficulty=difficulty,
            query_strategy=strategy,
        )

    def extract_entities(self, question: str) -> EntityExtractionResult:
        return self.fallback.extract_entities(question)

    def rewrite_query(self, question: str, intent: IntentResult, entities: EntityExtractionResult) -> str:
        baseline = self.fallback.rewrite_query(question, intent, entities)
        if intent.query_strategy == "direct" or self.config.query_agent_provider != "langchain":
            return baseline
        rewritten = self._invoke_langchain_agent(question, intent, entities)
        return rewritten or baseline

    def expand_queries(
        self,
        question: str,
        intent: IntentResult,
        entities: EntityExtractionResult,
    ) -> list[str]:
        """Build a bounded Multi-Query plan while retaining the user's wording."""

        baseline = self.rewrite_query(question, intent, entities)
        max_variants = max(1, self.config.max_query_rewrites + 1)
        expand = getattr(self.fallback, "expand_query_variants", None)
        if callable(expand):
            variants = expand(
                question,
                intent,
                entities,
                baseline=baseline,
                max_variants=max_variants,
            )
        else:
            variants = [question, baseline]
        return unique_keep_order(variants)[:max_variants]

    def _bert_prediction(self, question: str) -> Optional[dict[str, Any]]:
        if self._bert_unavailable:
            return None
        model_path = Path(self.config.query_classifier_model)
        if not model_path.exists():
            self._bert_unavailable = True
            return None
        try:
            if self._bert is None:
                from transformers import pipeline  # type: ignore[import-not-found]

                self._bert = pipeline(
                    "text-classification",
                    model=str(model_path),
                    tokenizer=str(model_path),
                    device=self.config.query_classifier_device,
                )
            output = self._bert(question, truncation=True, max_length=512)
            return output[0] if output and isinstance(output[0], dict) else None
        except Exception:  # noqa: BLE001 - rule classifier remains the explicit local fallback.
            self._bert_unavailable = True
            return None

    def _invoke_langchain_agent(
        self,
        question: str,
        intent: IntentResult,
        entities: EntityExtractionResult,
    ) -> str:
        if self._agent_unavailable:
            return ""
        api_key = os.getenv(self.config.llm_api_key_env, "").strip()
        if not api_key:
            self._agent_unavailable = True
            return ""
        try:
            if self._agent is None:
                from langchain.agents import create_agent  # type: ignore[import-not-found]
                from langchain_openai import ChatOpenAI  # type: ignore[import-not-found]

                model = ChatOpenAI(
                    model=self.config.llm_model,
                    api_key=api_key,
                    base_url=chat_api_root(self.config.llm_api_base_url),
                    temperature=0,
                    timeout=self.config.llm_timeout_seconds,
                )
                self._agent = create_agent(
                    model=model,
                    tools=[],
                    system_prompt=(
                        "你是教育文档RAG检索查询优化Agent。针对复杂、长句或模糊问题，执行问题改写、"
                        "关键点拆解和同义语义增强；保留原问题的限定条件，不引入新事实。"
                        "最后只输出一行适合混合检索的查询文本。"
                    ),
                )
            payload = json.dumps(
                {"question": question, "intent": intent.to_dict(), "entities": entities.to_dict()},
                ensure_ascii=False,
            )
            result = self._agent.invoke({"messages": [{"role": "user", "content": payload}]})
            messages = result.get("messages") if isinstance(result, dict) else None
            content = getattr(messages[-1], "content", "") if messages else ""
            return str(content).strip().replace("\n", " ")[:2000]
        except Exception:  # noqa: BLE001 - deterministic rewrite keeps the request available.
            self._agent_unavailable = True
            return ""


ALLOWED_INTENTS = {
    "document_answer",
    "course_learning",
    "assignment_query",
    "exam_preparation",
    "campus_policy",
    "chit_chat",
    "unauthorized_query",
    "malicious_attack",
    "empty",
}


def assess_query_difficulty(question: str) -> str:
    normalized = re.sub(r"\s+", "", str(question or ""))
    separators = len(re.findall(r"[，,；;、]|以及|并且|分别|比较|结合|为什么.+如何", normalized))
    ambiguous = any(term in normalized for term in ("这个", "它", "上述", "相关内容", "详细说说", "分析一下"))
    if len(normalized) >= 80 or separators >= 3:
        return "complex"
    if len(normalized) >= 36 or separators >= 1 or ambiguous:
        return "moderate"
    return "simple"


def normalize_bert_label(label: str) -> str:
    normalized = label.strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "learning": "course_learning",
        "assignment": "assignment_query",
        "exam": "exam_preparation",
        "policy": "campus_policy",
        "chat": "chit_chat",
        "malicious": "malicious_attack",
        "unauthorized": "unauthorized_query",
    }
    return aliases.get(normalized, normalized)


def chat_api_root(url: str) -> str:
    return re.sub(r"/chat/completions/?$", "", str(url).rstrip("/"))
