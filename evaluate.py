"""
Reproducible evaluation of the two prompt-injection guardrails (Laya System 1 vs Vector RAG).

Benchmark : deepset/prompt-injections  (train 546 / held-out test 116; label 1 = injection)
Protocol  : * Laya is zero-shot, so it is scored on the test split (primary) and the train split
              (used only to choose an alternative operating threshold).
            * Vector RAG is indexed from the TRAIN split and scored on the TEST split, so no
              test prompt is ever in the index. The RAG index as currently deployed in server.py
              (40 seed prompts, because the hlyn-labs dataset is unreachable offline) is also scored.
            * Latency is wall-clock time around the guardrail call after a warm-up, on this machine.
            * RAM is the change in process RSS while loading each model.

Usage:  python evaluate.py [--out eval_results] [--skip-laya-train] [--limit N]
"""
import os
import sys
import json
import time
import math
import argparse
import logging

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_DATASETS_OFFLINE"] = "1"
logging.disable(logging.CRITICAL)

import numpy as np
import psutil
from datasets import load_dataset
from sklearn.metrics import (average_precision_score, confusion_matrix, matthews_corrcoef,
                             precision_recall_curve, roc_auc_score, roc_curve)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rag_guardrail import RAGPromptGuardrail  # noqa: E402
from laya_guardrail import LayaPromptGuardrail  # noqa: E402

PROC = psutil.Process()


def rss_mb():
    return PROC.memory_info().rss / 2 ** 20


def wilson(k, n, z=1.96):
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    a = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - a) / d, (c + a) / d)


def metrics(y, pred, score):
    y, pred, score = np.asarray(y), np.asarray(pred).astype(int), np.asarray(score, dtype=float)
    tn, fp, fn, tp = confusion_matrix(y, pred, labels=[0, 1]).ravel()
    n = len(y)
    div = lambda a, b: a / b if b else float("nan")
    out = {
        "n": int(n), "positives": int(y.sum()), "negatives": int((1 - y).sum()),
        "tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp),
        "accuracy": div(tp + tn, n), "precision": div(tp, tp + fp), "recall": div(tp, tp + fn),
        "specificity": div(tn, tn + fp), "fpr": div(fp, fp + tn), "fnr": div(fn, fn + tp),
        "mcc": float(matthews_corrcoef(y, pred)),
        "roc_auc": float(roc_auc_score(y, score)), "avg_precision": float(average_precision_score(y, score)),
    }
    p, r = out["precision"], out["recall"]
    out["f1"] = div(2 * p * r, p + r) if p == p and r == r else float("nan")
    out["ci"] = {
        "accuracy": wilson(tp + tn, n), "precision": wilson(tp, tp + fp),
        "recall": wilson(tp, tp + fn), "fpr": wilson(fp, fp + tn),
    }
    rng = np.random.default_rng(0)
    aucs = []
    for _ in range(1000):
        idx = rng.integers(0, n, n)
        if y[idx].min() != y[idx].max():
            aucs.append(roc_auc_score(y[idx], score[idx]))
    out["roc_auc_ci"] = (float(np.percentile(aucs, 2.5)), float(np.percentile(aucs, 97.5)))
    return out


def latency_stats(ms):
    a = np.asarray(ms, dtype=float)
    return {"n": int(len(a)), "mean": float(a.mean()), "median": float(np.median(a)),
            "p95": float(np.percentile(a, 95)), "p99": float(np.percentile(a, 99)),
            "min": float(a.min()), "max": float(a.max())}


def build_rag(items):
    g = RAGPromptGuardrail()
    g._init_encoder()
    g.vector_store = items
    g.embeddings_matrix = g.model.encode([i["text"] for i in items], show_progress_bar=False, normalize_embeddings=True)
    g.is_initialized = True
    return g


def run_rag(g, texts, tag):
    for t in texts[:5]:
        g.evaluate_prompt(t)  # warm-up
    scores, preds, lats = [], [], []
    for i, t in enumerate(texts):
        t0 = time.perf_counter()
        r = g.evaluate_prompt(t)
        lats.append((time.perf_counter() - t0) * 1000)
        scores.append(r["risk_score"])
        preds.append(0 if r["is_safe"] else 1)
        if (i + 1) % 25 == 0:
            print(f"  [{tag}] {i + 1}/{len(texts)}", flush=True)
    return scores, preds, lats


def run_laya(g, texts, tag):
    for t in texts[:3]:
        g.evaluate_prompt(t)  # warm-up
    scores, preds, lats, cats, fallbacks = [], [], [], [], 0
    for i, t in enumerate(texts):
        t0 = time.perf_counter()
        r = g.evaluate_prompt(t)
        lats.append((time.perf_counter() - t0) * 1000)
        d = r.get("laya_decisions", {})
        if "noul_attack_score" not in d:
            fallbacks += 1  # Laya call failed and the code silently used the vector fallback
        scores.append(r["risk_percentage"] / 100.0)
        preds.append(0 if r["is_safe"] else 1)
        cats.append(d.get("threat_category", ""))
        if (i + 1) % 10 == 0:
            print(f"  [{tag}] {i + 1}/{len(texts)}  last={lats[-1]:.0f} ms", flush=True)
    return scores, preds, lats, cats, fallbacks


def sweep(y, score, grid):
    y, score = np.asarray(y), np.asarray(score)
    rows = []
    for th in grid:
        pred = (score >= th).astype(int)
        tn, fp, fn, tp = confusion_matrix(y, pred, labels=[0, 1]).ravel()
        p = tp / (tp + fp) if tp + fp else float("nan")
        r = tp / (tp + fn) if tp + fn else float("nan")
        f1 = 2 * p * r / (p + r) if p == p and r == r and (p + r) else float("nan")
        rows.append({"threshold": float(th), "precision": p, "recall": r, "f1": f1, "fpr": fp / (fp + tn)})
    return rows


def errors(texts, y, pred, score, kind, k=8):
    idx = [i for i in range(len(y)) if (kind == "fn" and y[i] == 1 and pred[i] == 0) or (kind == "fp" and y[i] == 0 and pred[i] == 1)]
    idx.sort(key=lambda i: -abs(score[i] - 0.5))
    return [{"text": texts[i][:160].replace("\n", " "), "score": round(float(score[i]), 3)} for i in idx[:k]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="eval_results")
    ap.add_argument("--skip-laya-train", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="debug: only use the first N prompts of each split")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    ds = load_dataset("deepset/prompt-injections")
    tr = [{"text": r["text"], "label": int(r["label"])} for r in ds["train"]]
    te = [{"text": r["text"], "label": int(r["label"])} for r in ds["test"]]
    if args.limit:
        tr, te = tr[:args.limit], te[:args.limit]
    te_t, te_y = [r["text"] for r in te], [r["label"] for r in te]
    tr_t, tr_y = [r["text"] for r in tr], [r["label"] for r in tr]
    print(f"train={len(tr)} test={len(te)} (test attacks={sum(te_y)})", flush=True)

    res = {"dataset": "deepset/prompt-injections", "n_train": len(tr), "n_test": len(te), "engines": {}, "ram_mb": {}}
    base = rss_mb()

    # ---- Vector RAG, indexed from the train split
    print("Loading Vector RAG (train-indexed)...", flush=True)
    rag = build_rag(tr)
    res["ram_mb"]["rag_encoder_plus_index"] = rss_mb() - base
    s, p, l = run_rag(rag, te_t, "rag-train-index")
    m = metrics(te_y, p, s)
    res["engines"]["rag_train_index"] = {"label": "Vector RAG (indexed on train split)", "metrics": m, "latency_ms": latency_stats(l),
                                         "fn": errors(te_t, te_y, p, s, "fn"), "fp": errors(te_t, te_y, p, s, "fp")}
    rag_pred, rag_score = p, s

    # ---- Vector RAG exactly as deployed (40 seed prompts)
    print("Vector RAG as deployed (seed index)...", flush=True)
    dep = RAGPromptGuardrail()
    dep.load_dataset_and_index(sample_size=1000)
    res["rag_deployed_index_size"] = len(dep.vector_store)
    s, p, l = run_rag(dep, te_t, "rag-deployed")
    res["engines"]["rag_deployed"] = {"label": f"Vector RAG (as deployed, {len(dep.vector_store)}-prompt index)", "metrics": metrics(te_y, p, s),
                                      "latency_ms": latency_stats(l), "fn": errors(te_t, te_y, p, s, "fn"), "fp": errors(te_t, te_y, p, s, "fp")}
    del dep

    # ---- Laya System 1
    print("Loading Laya (this can take a while on CPU)...", flush=True)
    before = rss_mb()
    lg = LayaPromptGuardrail()
    lg.initialize()
    if lg.agent is None:
        print("ABORT: Laya model did not load; the guardrail would silently use the vector fallback.", flush=True)
        sys.exit(2)
    res["ram_mb"]["laya_model"] = rss_mb() - before
    s, p, l, cats, fb = run_laya(lg, te_t, "laya-test")
    m = metrics(te_y, p, s)
    res["engines"]["laya"] = {"label": "Laya System 1 (zero-shot)", "metrics": m, "latency_ms": latency_stats(l), "fallback_calls": fb,
                              "category_counts": {c: cats.count(c) for c in sorted(set(cats))},
                              "fn": errors(te_t, te_y, p, s, "fn"), "fp": errors(te_t, te_y, p, s, "fp")}
    laya_pred, laya_score = p, s
    res["ram_mb"]["peak_rss_total"] = rss_mb()

    grid = np.round(np.arange(0.1, 1.0, 0.1), 2)
    res["laya_threshold_sweep_test"] = sweep(te_y, laya_score, grid)

    # ---- Laya on the train split: choose an alternative threshold without touching test
    if not args.skip_laya_train:
        print("Scoring Laya on the train split for threshold selection...", flush=True)
        s2, p2, l2, _, fb2 = run_laya(lg, tr_t, "laya-train")
        res["engines"]["laya_train"] = {"label": "Laya System 1 on train split", "metrics": metrics(tr_y, p2, s2),
                                        "latency_ms": latency_stats(l2), "fallback_calls": fb2}
        fine = np.round(np.arange(0.05, 0.96, 0.05), 2)
        tsw = sweep(tr_y, s2, fine)
        best = max((r for r in tsw if r["f1"] == r["f1"]), key=lambda r: r["f1"])
        th = best["threshold"]
        pt = (np.asarray(laya_score) >= th).astype(int)
        res["laya_tuned"] = {"threshold_from_train": th, "train_f1": best["f1"], "test_metrics": metrics(te_y, pt, laya_score)}
        res["laya_threshold_sweep_train"] = tsw

    # ---- paired comparison (McNemar exact) on the test set
    from scipy.stats import binomtest
    lc = [int(a == b) for a, b in zip(laya_pred, te_y)]
    rc = [int(a == b) for a, b in zip(rag_pred, te_y)]
    b = sum(1 for x, y2 in zip(lc, rc) if x and not y2)
    c = sum(1 for x, y2 in zip(lc, rc) if (not x) and y2)
    res["mcnemar_laya_vs_rag_train_index"] = {"laya_only_correct": b, "rag_only_correct": c,
                                              "p_value": float(binomtest(b, b + c, 0.5).pvalue) if b + c else 1.0}

    json.dump(res, open(os.path.join(args.out, "results.json"), "w"), indent=2, default=float)
    np.save(os.path.join(args.out, "laya_scores_test.npy"), np.asarray(laya_score))
    np.save(os.path.join(args.out, "rag_scores_test.npy"), np.asarray(rag_score))
    np.save(os.path.join(args.out, "y_test.npy"), np.asarray(te_y))
    print("DONE ->", os.path.join(args.out, "results.json"), flush=True)


if __name__ == "__main__":
    main()
