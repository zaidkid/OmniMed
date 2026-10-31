"""Find out why Qwen is slow to start. Run:  python ollama_probe.py --model qwen3:8b

Measures model load, prompt processing speed and GPU/CPU placement using the same
num_ctx as OmniMed. No OmniMed code is needed.
"""
import argparse
import time

import httpx

parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True)
parser.add_argument("--base-url", default="http://127.0.0.1:11434")
parser.add_argument("--num-ctx", type=int, default=4096)
parser.add_argument("--chars", type=int, default=6000, help="size of the test prompt")
args = parser.parse_args()
base = args.base_url.rstrip("/")


def generate(prompt: str) -> tuple[float, dict]:
    started = time.perf_counter()
    r = httpx.post(f"{base}/api/generate", timeout=600, json={
        "model": args.model, "prompt": prompt, "stream": False, "think": False,
        "keep_alive": "30m", "options": {"num_ctx": args.num_ctx, "num_predict": 8},
    })
    r.raise_for_status()
    return time.perf_counter() - started, r.json()


def placement() -> str:
    for m in httpx.get(f"{base}/api/ps", timeout=10).json().get("models", []):
        if args.model in (m.get("name"), m.get("model")) or f"{args.model}:latest" in (m.get("name"), m.get("model")):
            size, vram = m.get("size") or 1, m.get("size_vram") or 0
            return f"{100 * vram / size:.0f}% in GPU memory (context {m.get('context_length')})"
    return "not loaded"


s = lambda ns: (ns or 0) / 1e9
print("Before:", placement())
wall, d = generate("Reply with OK.")
print(f"\nTiny prompt: {wall:.1f}s total, model load {s(d.get('load_duration')):.1f}s")
wall, d = generate("Patient report line. " * (args.chars // 21))
tokens, secs = d.get("prompt_eval_count") or 0, s(d.get("prompt_eval_duration"))
print(f"Big prompt:  {wall:.1f}s total, {tokens} prompt tokens processed in {secs:.1f}s "
      f"= {tokens / secs if secs else 0:.0f} tokens/s, model load {s(d.get('load_duration')):.1f}s")
print("After: ", placement())
print("""
How to read this:
- model load > 5s on the second call  -> the model keeps reloading (different num_ctx, or another app unloads it)
- prompt speed below ~200 tokens/s    -> prompt processing is the delay; the model is partly or fully on CPU
- GPU percent below 100               -> lower OLLAMA_NUM_PARALLEL to 1, enable OLLAMA_FLASH_ATTENTION=1,
                                         lower --num-ctx, or use a smaller model / quantization""")