"""Manufacturing-specific safety review and redaction utilities."""

from __future__ import annotations

import re
from typing import Iterable, List

from manufacturing_rag.config import DEFAULT_CONFIG, RAGConfig
from manufacturing_rag.query import MALICIOUS_TERMS, UNAUTHORIZED_TERMS, normalize_text
from manufacturing_rag.schemas import SafetyResult


class SafetyGuard:
    """Front and post safety guard for industrial document QA."""

    credential_pattern = re.compile(
        r"(?i)\b(password|passwd|token|api[_-]?key|secret|密钥|密码)\b\s*[:=：]\s*[^\s,;，。]+"
    )
    secrecy_pattern = re.compile(r"(绝密|机密|商业秘密|受控文件|未授权|内部保密)")

    def __init__(self, config: RAGConfig = DEFAULT_CONFIG) -> None:
        self.config = config

    def assess_question(self, question: str) -> SafetyResult:
        normalized = normalize_text(question)
        lower = normalized.lower()
        risk_types: List[str] = []
        if any(term.lower() in lower for term in MALICIOUS_TERMS):
            risk_types.append("prompt_injection_or_destructive_instruction")
        if any(term.lower() in lower for term in UNAUTHORIZED_TERMS):
            risk_types.append("unauthorized_or_confidential_access")
        if self.credential_pattern.search(normalized):
            risk_types.append("credential_exposure")
        if not normalized:
            risk_types.append("empty_query")
        if risk_types:
            return SafetyResult(False, "high", risk_types, "前置安全审核未通过")
        return SafetyResult(True, "low", [], "前置安全审核通过")

    def redact(self, text: str, extra_terms: Iterable[str] = ()) -> str:
        redacted = self.credential_pattern.sub(lambda match: f"{match.group(1)}=[已脱敏]", text)
        redacted = self.secrecy_pattern.sub("[密级已脱敏]", redacted)
        for term in list(self.config.sensitive_terms) + list(extra_terms):
            if term and term in redacted:
                if term in {"密码", "密钥", "token", "api_key", "apikey", "secret"}:
                    redacted = redacted.replace(term, "[敏感凭据已脱敏]")
        return redacted

    def post_audit(self, answer: str) -> SafetyResult:
        risks: List[str] = []
        if self.credential_pattern.search(answer):
            risks.append("credential_exposure")
        if self.secrecy_pattern.search(answer):
            risks.append("confidential_marker")
        if risks:
            return SafetyResult(False, "medium", risks, "后置安全审核发现需脱敏内容")
        return SafetyResult(True, "low", [], "后置安全审核通过")
