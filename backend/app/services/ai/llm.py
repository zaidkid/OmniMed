from __future__ import annotations

import json
import os
import time
from typing import Any, AsyncIterator

import httpx
from app.core.config import OLLAMA_BASE_URL, OLLAMA_MODEL


def _read_timeout() -> float | None:
    raw = os.getenv("OLLAMA_READ_TIMEOUT_SECONDS", "").strip()
    if not raw:
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    return value if value > 0 else None


def _env_number(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


OLLAMA_TIMEOUT_SECONDS = _read_timeout()
OLLAMA_NUM_PREDICT = 4096

# Clinical-brief streaming defaults. All can be tuned without code changes.
# The SAME num_ctx must be used by warm-up and generation, otherwise Ollama
# reloads the model (this is what makes a "first token" take a minute).
BRIEF_NUM_CTX = int(_env_number("OMNIMED_NUM_CTX", 4096))
BRIEF_NUM_PREDICT = int(_env_number("OMNIMED_NUM_PREDICT", 1500))
THINK_BUDGET_SECONDS = _env_number("OMNIMED_THINK_BUDGET_SECONDS", 15)
THINK_BUDGET_CHARS = int(_env_number("OMNIMED_THINK_BUDGET_CHARS", 1500))
# Token cap for the answer once thinking was cut off (the detailed brief JSON is ~350-600 tokens).
BRIEF_ANSWER_NUM_PREDICT = int(_env_number("OMNIMED_ANSWER_NUM_PREDICT", 900))
# OMNIMED_THINK=off skips reasoning completely (fastest on CPU-only machines).
THINK_ENABLED = os.getenv("OMNIMED_THINK", "on").strip().lower() not in {"0", "off", "false", "no"}


class OllamaEmptyResponseError(RuntimeError):
    """Ollama answered but the response text was empty."""


class OllamaOutputLimitError(RuntimeError):
    """Generation stopped because num_predict was reached."""


class _ThinkingUnsupported(Exception):
    """The model or Ollama version rejected the `think` option."""


class _ThinkingBudgetReached(Exception):
    """Thinking exceeded its time/character budget; the answer is requested next."""

    def __init__(self, seconds: float, characters: int):
        super().__init__("thinking budget reached")
        self.seconds = seconds
        self.characters = characters


def _options(temperature: float, num_predict: int, num_ctx: int | None) -> dict[str, Any]:
    options: dict[str, Any] = {"temperature": temperature, "num_predict": num_predict}
    if num_ctx:
        options["num_ctx"] = int(num_ctx)
    return options


async def ollama_generate_with_meta(
    prompt: str,
    output_schema: dict | None = None,
    *,
    model: str | None = None,
    num_predict: int = OLLAMA_NUM_PREDICT,
    keep_alive: str = "30m",
    temperature: float = 0.1,
    num_ctx: int | None = None,
    think: bool = False,
) -> dict[str, Any]:
    used_model = model or OLLAMA_MODEL
    payload: dict[str, Any] = {
        "model": used_model, "prompt": prompt, "stream": False,
        "think": think, "keep_alive": keep_alive,
        "options": _options(temperature, num_predict, num_ctx),
        "format": output_schema if output_schema is not None else "json",
    }
    timeout = httpx.Timeout(_read_timeout(), connect=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(f"{OLLAMA_BASE_URL.rstrip('/')}/api/generate", json=payload)
        response.raise_for_status()
        data = response.json()
    raw = data.get("response", "")
    if not isinstance(raw, str) or not raw.strip():
        raise OllamaEmptyResponseError("Ollama returned an empty response.")
    if data.get("done_reason") == "length":
        raise OllamaOutputLimitError(f"Ollama reached its output limit ({num_predict} tokens).")
    return {
        "text": raw.strip(),
        "thinking": data.get("thinking") if isinstance(data.get("thinking"), str) else "",
        "model": used_model,
        "prompt_eval_count": data.get("prompt_eval_count"),
        "eval_count": data.get("eval_count"),
        "done_reason": data.get("done_reason"),
    }


async def ollama_generate(
    prompt: str,
    output_schema: dict | None = None,
    *,
    model: str | None = None,
    num_predict: int = OLLAMA_NUM_PREDICT,
    keep_alive: str = "30m",
    temperature: float = 0.1,
) -> str:
    result = await ollama_generate_with_meta(
        prompt, output_schema, model=model, num_predict=num_predict,
        keep_alive=keep_alive, temperature=temperature, think=False,
    )
    return result["text"]


async def _stream_once(
    payload: dict[str, Any],
    num_predict: int,
    budget_seconds: float | None = None,
    budget_chars: int | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """One streamed /api/generate call. Forwards only what Ollama actually emitted."""
    timeout = httpx.Timeout(_read_timeout(), connect=10.0)
    parts: list[str] = []
    think_started: float | None = None
    think_seconds: float | None = None
    thinking_chars = 0
    last: dict[str, Any] = {}
    started = time.perf_counter()
    first_token_sent = False

    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream(
            "POST", f"{OLLAMA_BASE_URL.rstrip('/')}/api/generate", json=payload
        ) as response:
            if response.is_error:
                body = (await response.aread()).decode("utf-8", "ignore")[:500]
                if payload.get("think") and response.status_code == 400 and "think" in body.lower():
                    raise _ThinkingUnsupported(body)
                raise RuntimeError(f"Ollama returned HTTP {response.status_code}: {body}")

            async for line in response.aiter_lines():
                if not line:
                    continue
                try:
                    chunk = json.loads(line)
                except json.JSONDecodeError:
                    continue
                last = chunk
                if chunk.get("error"):
                    raise RuntimeError(f"Ollama error: {chunk['error']}")

                thinking = chunk.get("thinking")
                token = chunk.get("response")
                if not first_token_sent and (
                    (isinstance(thinking, str) and thinking) or (isinstance(token, str) and token)
                ):
                    first_token_sent = True
                    yield {"type": "first_token", "seconds": round(time.perf_counter() - started, 2)}

                if isinstance(thinking, str) and thinking:
                    if think_started is None:
                        think_started = time.perf_counter()
                    thinking_chars += len(thinking)
                    yield {"type": "thinking", "text": thinking}
                    elapsed = time.perf_counter() - think_started
                    if (budget_chars and thinking_chars >= budget_chars) or (
                        budget_seconds and elapsed >= budget_seconds
                    ):
                        think_seconds = round(elapsed, 1)
                        yield {"type": "thinking_end", "seconds": think_seconds, "limited": True}
                        # Leaving the `async with` closes the connection; Ollama stops generating.
                        raise _ThinkingBudgetReached(think_seconds, thinking_chars)

                if isinstance(token, str) and token:
                    if think_started is not None and think_seconds is None:
                        think_seconds = round(time.perf_counter() - think_started, 1)
                        yield {"type": "thinking_end", "seconds": think_seconds}
                    parts.append(token)
                    yield {"type": "response", "text": token}

                if chunk.get("done"):
                    break

    if think_started is not None and think_seconds is None:
        think_seconds = round(time.perf_counter() - think_started, 1)
        yield {"type": "thinking_end", "seconds": think_seconds}

    final_text = "".join(parts).strip()
    if not final_text:
        raise OllamaEmptyResponseError("Ollama returned an empty streamed response.")
    if last.get("done_reason") == "length":
        raise OllamaOutputLimitError(f"Ollama reached its output limit ({num_predict} tokens).")
    yield {
        "type": "done", "text": final_text,
        "prompt_eval_count": last.get("prompt_eval_count"),
        "eval_count": last.get("eval_count"),
        "done_reason": last.get("done_reason"),
        "thinking_available": think_started is not None,
        "thinking_characters": thinking_chars,
        "thinking_seconds": think_seconds,
        "load_duration": last.get("load_duration"),
        "prompt_eval_duration": last.get("prompt_eval_duration"),
        "eval_duration": last.get("eval_duration"),
    }


async def ollama_warm_up(model: str | None = None, keep_alive: str = "30m") -> None:
    """Load the configured Ollama model and verify the warm-up succeeded.

    Uses the same context length as clinical-brief generation. Raises RuntimeError
    instead of silently ignoring connection, HTTP, or response-validation errors.
    """
    model_name = model or OLLAMA_MODEL
    payload = {
        "model": model_name,
        "prompt": "",
        "stream": False,
        "keep_alive": keep_alive,
        "options": {"num_ctx": BRIEF_NUM_CTX},
    }

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(180.0, connect=5.0)
        ) as client:
            response = await client.post(
                f"{OLLAMA_BASE_URL.rstrip('/')}/api/generate",
                json=payload,
            )
            response.raise_for_status()

            try:
                data = response.json()
            except ValueError as exc:
                raise RuntimeError("Ollama returned invalid JSON during warm-up.") from exc

            returned_model = data.get("model")
            if returned_model != model_name:
                raise RuntimeError(
                    f"Expected model '{model_name}', but Ollama returned "
                    f"'{returned_model}'."
                )

            if data.get("done") is not True:
                raise RuntimeError(
                    "Ollama did not confirm completion of the warm-up request."
                )

    except Exception as exc:
        raise RuntimeError(
            f"Failed to warm up Ollama model '{model_name}': {exc}"
        ) from exc

async def ollama_generate_stream(
    prompt: str,
    output_schema: dict | None = None,
    *,
    model: str | None = None,
    num_predict: int = BRIEF_NUM_PREDICT,
    keep_alive: str = "30m",
    temperature: float = 0.1,
    think: bool = True,
    num_ctx: int | None = BRIEF_NUM_CTX,
    think_budget_seconds: float | None = THINK_BUDGET_SECONDS,
    think_budget_chars: int | None = THINK_BUDGET_CHARS,
    answer_num_predict: int = BRIEF_ANSWER_NUM_PREDICT,
) -> AsyncIterator[dict[str, Any]]:
    """Stream Ollama thinking and answer fragments exactly as emitted.

    Events: first_token, thinking, thinking_end, thinking_budget, response, done,
    thinking_unsupported. `thinking` is the separate field returned by Ollama.

    Thinking is time/character budgeted so latency is bounded: when the budget is
    reached the thinking stream is closed and the answer is requested immediately
    (same prompt, so Ollama reuses its prompt cache). If the model rejects `think`,
    it is retried once without it. Nothing is fabricated.
    """
    used_model = model or OLLAMA_MODEL
    predict = num_predict
    options = _options(temperature, predict, num_ctx)
    use_think = think
    carry: dict[str, Any] = {}

    while True:
        payload: dict[str, Any] = {
            "model": used_model, "prompt": prompt, "stream": True,
            "think": use_think, "keep_alive": keep_alive, "options": options,
            "format": output_schema if output_schema is not None else "json",
        }
        try:
            async for item in _stream_once(
                payload, predict,
                think_budget_seconds if use_think else None,
                think_budget_chars if use_think else None,
            ):
                if item["type"] == "done":
                    item["model"] = used_model
                    item.update(carry)
                yield item
            return
        except _ThinkingBudgetReached as exc:
            use_think = False
            predict = min(predict, answer_num_predict)
            options = _options(temperature, predict, num_ctx)
            carry = {
                "thinking_available": True,
                "thinking_seconds": exc.seconds,
                "thinking_characters": exc.characters,
            }
            yield {"type": "thinking_budget", "seconds": exc.seconds, "characters": exc.characters}
        except _ThinkingUnsupported as exc:
            if not use_think:
                raise RuntimeError(str(exc)) from exc
            use_think = False
            yield {"type": "thinking_unsupported", "model": used_model, "detail": str(exc)[:200]}


async def ollama_model_status(model: str | None = None) -> dict[str, Any]:
    """Is the model loaded in Ollama, and how much of it sits in GPU memory (/api/ps)?

    Returns {"loaded": True|False|None, "gpu_percent": int|None, "context_length": int|None};
    loaded is None when Ollama could not be queried.
    """
    used = model or OLLAMA_MODEL
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(3.0)) as client:
            response = await client.get(f"{OLLAMA_BASE_URL.rstrip('/')}/api/ps")
            response.raise_for_status()
            for item in response.json().get("models", []):
                names = {item.get("name"), item.get("model")}
                if used in names or f"{used}:latest" in names:
                    size, vram = item.get("size") or 0, item.get("size_vram") or 0
                    return {
                        "loaded": True,
                        "gpu_percent": round(100 * vram / size) if size else None,
                        "context_length": item.get("context_length"),
                    }
            return {"loaded": False, "gpu_percent": None, "context_length": None}
    except Exception:
        return {"loaded": None, "gpu_percent": None, "context_length": None}


async def check_ollama():
    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
        response = await client.get(f"{OLLAMA_BASE_URL.rstrip('/')}/api/tags")
        response.raise_for_status()
        return response.json()