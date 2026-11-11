"""Offline recall and grounded-answer evaluation for a subject test set."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Iterable, List

from manufacturing_rag.pipeline import ManufacturingRAGPipeline, retrieve_with_query_variants


@dataclass(frozen=True)
class EvaluationCase:
    question: str
    expected_chunk_ids: List[str]
    expected_answer_terms: List[str]

    @classmethod
    def from_mapping(cls, value: dict[str, Any]) -> "EvaluationCase":
        return cls(
            question=str(value["question"]),
            expected_chunk_ids=[str(item) for item in value.get("expected_chunk_ids") or []],
            expected_answer_terms=[str(item) for item in value.get("expected_answer_terms") or []],
        )


@dataclass(frozen=True)
class EvaluationReport:
    case_count: int
    recall_at_k: float
    mean_reciprocal_rank: float
    answer_term_accuracy: float
    grounded_rate: float

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class RAGEvaluator:
    def __init__(self, pipeline: ManufacturingRAGPipeline) -> None:
        self.pipeline = pipeline

    def evaluate(self, cases: Iterable[EvaluationCase]) -> EvaluationReport:
        case_list = list(cases)
        recall_hits = 0
        reciprocal_rank_sum = 0.0
        answer_accuracy_sum = 0.0
        grounded_hits = 0
        for case in case_list:
            intent = self.pipeline.query_optimizer.classify_intent(case.question)
            entities = self.pipeline.query_optimizer.extract_entities(case.question)
            query_variants = self.pipeline.query_optimizer.expand_queries(case.question, intent, entities)
            if not query_variants:
                query_variants = [case.question]
            results = retrieve_with_query_variants(
                self.pipeline.retriever,
                query_variants,
                entities,
                limit=self.pipeline.config.top_k,
                rrf_k=self.pipeline.config.rrf_k,
            )
            retrieved_ids = [result.chunk.id for result in results]
            expected_ids = set(case.expected_chunk_ids)
            matching_ranks = [index for index, chunk_id in enumerate(retrieved_ids, start=1) if chunk_id in expected_ids]
            if matching_ranks:
                recall_hits += 1
                reciprocal_rank_sum += 1.0 / min(matching_ranks)
            response = self.pipeline.answer(case.question)
            if case.expected_answer_terms:
                answer_accuracy_sum += sum(term in response.answer for term in case.expected_answer_terms) / len(case.expected_answer_terms)
            else:
                answer_accuracy_sum += 1.0
            grounded_hits += int(response.hallucination_check.passed and bool(response.sources or "资料不足" in response.answer))
        denominator = max(len(case_list), 1)
        return EvaluationReport(
            case_count=len(case_list),
            recall_at_k=recall_hits / denominator,
            mean_reciprocal_rank=reciprocal_rank_sum / denominator,
            answer_term_accuracy=answer_accuracy_sum / denominator,
            grounded_rate=grounded_hits / denominator,
        )
