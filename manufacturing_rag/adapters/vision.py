"""Qwen-VL adapter used to complement OCR with image semantics."""

from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

from manufacturing_rag.config import DEFAULT_CONFIG, RAGConfig
from manufacturing_rag.resilience import retry_call


class QwenVLAdapter:
    """Describe diagrams, formulas and tables through a Qwen-VL compatible endpoint."""

    def __init__(self, config: RAGConfig = DEFAULT_CONFIG) -> None:
        self.config = config
        self.api_key = os.getenv(config.vision_api_key_env, "").strip()

    def describe_file(self, path: str, prompt: Optional[str] = None) -> str:
        file_path = Path(path)
        mime_type = mime_for_suffix(file_path.suffix)
        return self.describe_bytes(file_path.read_bytes(), mime_type=mime_type, prompt=prompt)

    def describe_bytes(self, image_bytes: bytes, mime_type: str = "image/png", prompt: Optional[str] = None) -> str:
        if not self.api_key:
            if self.config.vision_fallback_enabled:
                return ""
            raise RuntimeError(f"Qwen-VL is enabled but {self.config.vision_api_key_env} is not configured")
        instruction = prompt or (
            "请提取这张教育资料图片中的图表含义、公式、变量关系和版面结构。"
            "只描述图片中可确认的信息，不猜测被遮挡或不可读内容。"
        )
        data_url = f"data:{mime_type};base64,{base64.b64encode(image_bytes).decode('ascii')}"
        payload = {
            "model": self.config.vision_model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": data_url}},
                        {"type": "text", "text": instruction},
                    ],
                }
            ],
            "temperature": 0.0,
        }
        request = urllib.request.Request(
            self.config.vision_api_base_url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            def execute() -> dict:
                with urllib.request.urlopen(request, timeout=self.config.vision_timeout_seconds) as response:
                    return json.loads(response.read().decode("utf-8"))

            result = retry_call(execute, self.config.retry_attempts, self.config.retry_base_seconds)
            return str(result["choices"][0]["message"]["content"]).strip()
        except (urllib.error.URLError, urllib.error.HTTPError, KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
            if self.config.vision_fallback_enabled:
                return ""
            raise RuntimeError(f"Qwen-VL request failed: {exc}") from exc


def mime_for_suffix(suffix: str) -> str:
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
        ".gif": "image/gif",
    }.get(str(suffix).lower(), "image/png")
