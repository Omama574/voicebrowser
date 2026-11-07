# Laya Prompt Security Gateway

A FastAPI gateway that checks every prompt for prompt injection **before** it reaches Google Gemini, and compares two guardrail designs behind one interface:

- **Laya System 1** - a non-autoregressive typed-decision model (`convaiinnovations/laya-typed-decisions`). It answers two questions in one forward pass: an attack probability (`noul`) and a threat category (`choice`).
- **Vector RAG** - `all-MiniLM-L6-v2` embeddings with cosine similarity against labelled attack and benign prompts.

Blocked prompts return a threat category and never call Gemini. A dashboard (Console / Compare / Dataset) shows the verdict, risk and timings.

## Run

```bash
pip install -r requirements.txt
cp .env.example .env          # set GEMINI_API_KEY (stays on the server)
python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

Open http://127.0.0.1:8000. Endpoints: `/api/laya/{evaluate,query}`, `/api/rag/{evaluate,query}`, `/api/compare`, `/api/dataset/samples`.

## Evaluation (measured)

`python evaluate.py` reproduces everything below (`eval_results/results.json`).

- **Benchmark:** `deepset/prompt-injections`, held-out **test split, 116 prompts** (60 attacks, 56 benign).
- **Protocol:** Laya is zero-shot. The Vector RAG index is built from the *train* split only, so no test prompt is in the index. "As deployed" is the 40-prompt seed index that `server.py` falls back to when the online dataset is unreachable.
- **Hardware:** Windows laptop, CPU only. Latency is wall-clock per prompt after warm-up.

| Engine | Accuracy | Precision | Recall | F1 | FPR | ROC-AUC | Median latency |
|---|---|---|---|---|---|---|---|
| Vector RAG (train-split index) | 0.80 | 0.97 | 0.63 | 0.77 | 1.8% | 0.88 | 29 ms |
| Vector RAG (as deployed, 40 prompts) | 0.72 | 0.89 | 0.53 | 0.67 | 7.1% | 0.83 | 35 ms |
| Laya @ 0.5 threshold (default) | 0.60 | 0.93 | 0.23 | 0.37 | 1.8% | 0.82 | 1,592 ms |
| Laya @ 0.1 threshold (picked on train) | 0.72 | 0.74 | 0.72 | 0.73 | 26.8% | 0.82 | 1,592 ms |

Laya mean latency was 3.1 s (p95 about 10 s) on CPU; its published 33 ms figure is for a GPU. RAM: Laya model roughly 0.4-1.0 GB RSS across two runs, RAG encoder plus index roughly 0.4-0.5 GB.

Reading the results:

- With the default question and 0.5 threshold, Laya catches only 23% of attacks (very few false alarms, but most attacks get through). Its ROC-AUC of 0.82 shows the signal exists; lowering the threshold trades recall for false positives.
- The trained-index vector baseline beat zero-shot Laya on this test set (McNemar exact test p = 2e-5). This is not a like-for-like contest: RAG saw in-distribution examples, and the test set contains many German prompts while this Laya checkpoint is English.
- Not tested: paraphrased/encoded/indirect injections, other benchmarks, GPU latency.

## Known limitations

- `server.py` adds a fixed `time.sleep(2.0)` to the `/api/rag/*` and `/api/compare` paths, and `laya_guardrail.py` reports Laya latency divided by 2. Dashboard timings are therefore illustrative. Use `evaluate.py` for real numbers.
- `test_guardrail.py` and `test_laya_system.py` are standalone scripts (`python test_laya_system.py` needs the server running); they are not wired into a test runner.
- Older documents in this repo (`FINAL_PROJECT_DOCUMENTATION`, the course report and slides) quote reference figures such as 24.5 ms, 83x faster and under 500 MB. The evaluation above does not reproduce those on a CPU; treat the table above as the measured result.
