const $ = (id) => document.getElementById(id);
let cachedDatasetSamples = [];

document.addEventListener("DOMContentLoaded", () => {
    // Tabs
    const tabBtns = document.querySelectorAll(".tab-btn");
    const views = document.querySelectorAll(".view");
    tabBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            tabBtns.forEach(b => b.classList.remove("active"));
            views.forEach(v => v.classList.remove("active"));
            btn.classList.add("active");
            $(btn.dataset.target).classList.add("active");
            if (btn.dataset.target === "sec-explorer" && cachedDatasetSamples.length === 0) loadDatasetSamples(false);
        });
    });

    // Theme toggle (system by default, remembered once chosen)
    $("btn-theme").addEventListener("click", () => {
        const root = document.documentElement;
        const current = root.getAttribute("data-theme") ||
            (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        const next = current === "dark" ? "light" : "dark";
        root.setAttribute("data-theme", next);
        try { localStorage.setItem("laya_theme", next); } catch (e) {}
    });

    // Prompt input
    const promptInput = $("prompt-input");
    const updateCount = () => { $("char-count").textContent = `${promptInput.value.length} characters`; };
    promptInput.addEventListener("input", updateCount);

    document.querySelectorAll(".chip").forEach(chip => {
        chip.addEventListener("click", () => {
            promptInput.value = chip.dataset.prompt;
            promptInput.focus();
            updateCount();
        });
    });

    // Engine selection shows the RAG latency note
    document.querySelectorAll('input[name="engine"]').forEach(r => {
        r.addEventListener("change", () => { $("rag-latency-notice").hidden = selectedEngine() !== "rag"; });
    });

    $("btn-run").addEventListener("click", runPipeline);
    promptInput.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") runPipeline();
    });

    $("btn-copy-llm").addEventListener("click", async () => {
        const btn = $("btn-copy-llm");
        try { await navigator.clipboard.writeText($("llm-output-text").textContent); btn.textContent = "Copied"; }
        catch (e) { btn.textContent = "Copy failed"; }
        setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    });

    $("btn-run-benchmark").addEventListener("click", runSideBySideBenchmark);
    $("bench-input").addEventListener("keydown", (e) => { if (e.key === "Enter") runSideBySideBenchmark(); });

    $("btn-refresh-samples").addEventListener("click", () => loadDatasetSamples(true));
    $("filter-samples-input").addEventListener("input", filterDatasetRows);
});

function selectedEngine() {
    const checked = document.querySelector('input[name="engine"]:checked');
    return checked ? checked.value : "laya";
}

function showError(id, message) {
    const el = $(id);
    el.textContent = message || "";
    el.hidden = !message;
}

function setBadge(el, state, text) {
    el.className = "badge" + (state ? ` ${state}` : "");
    el.textContent = text;
}

function fmtMs(n) {
    const v = Number(n) || 0;
    return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(v < 100 ? 1 : 0)} ms`;
}

async function postJson(url, body) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        let detail = `Request failed (${res.status})`;
        try { detail = (await res.json()).detail || detail; } catch (e) {}
        throw new Error(detail);
    }
    return res.json();
}

async function runPipeline() {
    const promptText = $("prompt-input").value.trim();
    showError("form-error", "");
    if (!promptText) {
        showError("form-error", "Enter a prompt to check.");
        return;
    }

    const engine = selectedEngine();
    const withLlm = $("toggle-llm").checked;
    const endpoint = `/api/${engine}/${withLlm ? "query" : "evaluate"}`;
    const engineName = engine === "laya" ? "Laya" : "Vector RAG";

    const btn = $("btn-run");
    btn.disabled = true;
    btn.textContent = "Running";

    $("timing-banner").hidden = false;
    $("findings-section").hidden = false;
    $("lbl-guardrail-time").textContent = engineName;
    ["val-laya-time", "val-llm-time", "val-total-time"].forEach(id => { $(id).textContent = "..."; });
    setBadge($("badge-verdict"), "", "Running");
    $("box-explanation").textContent = `${engineName} is evaluating the prompt.`;
    $("llm-output-text").textContent = withLlm ? "Waiting for Gemini." : "Gemini was skipped for this check.";

    try {
        const data = await postJson(endpoint, { prompt: promptText });
        renderPipelineResults(engine, data, withLlm);
    } catch (e) {
        showError("form-error", e.message || `Could not reach the ${engineName} server.`);
        $("timing-banner").hidden = true;
        $("findings-section").hidden = true;
    } finally {
        btn.disabled = false;
        btn.textContent = "Run check";
    }
}

function renderPipelineResults(engine, data, withLlm) {
    const ev = data.laya_evaluation || data.guardrail_evaluation || data;
    const isSafe = ev.is_safe;
    const riskPct = ev.risk_percentage !== undefined ? Number(ev.risk_percentage) : Number(ev.risk_score) * 100;
    const engineName = engine === "laya" ? "Laya" : "Vector RAG";

    const t = data.timings || {};
    const guardrailMs = t.laya_guardrail_time_ms || t.rag_guardrail_time_ms || ev.laya_execution_time_ms || ev.rag_execution_time_ms || 0;
    const llmMs = t.gemini_llm_time_ms || 0;
    const totalMs = t.total_pipeline_time_ms || guardrailMs + llmMs;

    // Titles
    $("title-verdict-card").textContent = `${engineName} verdict`;
    $("title-inspector-card").textContent = engine === "laya" ? "Laya decisions" : "Closest known prompts";
    $("hint-inspector-card").textContent = engine === "laya" ? "Typed output" : "Cosine similarity";

    // Timings
    $("lbl-guardrail-time").textContent = engineName;
    $("val-laya-time").textContent = fmtMs(guardrailMs);
    $("val-llm-time").textContent = withLlm ? fmtMs(llmMs) : "skipped";
    $("val-total-time").textContent = fmtMs(totalMs);

    // Verdict + risk
    setBadge($("badge-verdict"), isSafe ? "passed" : "blocked", isSafe ? "Passed" : "Blocked");
    const fill = $("risk-bar-fill");
    fill.style.width = `${Math.min(100, Math.max(0, riskPct))}%`;
    fill.style.backgroundColor = isSafe ? "var(--success)" : "var(--danger)";
    $("txt-risk-score").textContent = `${riskPct.toFixed(1)}%`;
    $("risk-tick").hidden = engine !== "laya";
    $("box-explanation").textContent = ev.explanation || `Verdict: ${ev.verdict} (risk ${riskPct.toFixed(1)}%).`;

    // Inspector
    const jsonBox = $("laya-json-output");
    const ragBox = $("rag-chunks-output");
    jsonBox.hidden = engine !== "laya";
    ragBox.hidden = engine === "laya";

    if (engine === "laya") {
        jsonBox.textContent = JSON.stringify({
            verdict: ev.verdict,
            risk_score: ev.risk_score,
            decisions: ev.laya_decisions || {
                is_injection_attack: !isSafe,
                threat_category: isSafe ? "benign_query" : "prompt_injection",
            },
        }, null, 2);
    } else {
        const matches = ev.top_matches || [];
        ragBox.innerHTML = matches.length === 0
            ? `<p class="muted">No similar prompts found.</p>`
            : matches.map((m, i) => {
                const attack = m.label === 1 || m.label_name === "PROMPT_INJECTION";
                const sim = m.similarity !== undefined ? `${(m.similarity * 100).toFixed(1)}%` : "n/a";
                return `
                    <div class="match">
                        <div class="match-meta">
                            <span class="badge ${attack ? "blocked" : "passed"}">${attack ? "Injection" : "Benign"}</span>
                            <span class="mono">#${i + 1} &middot; ${sim}</span>
                        </div>
                        <div class="match-text">${escapeHtml(m.text)}</div>
                    </div>`;
            }).join("");
    }

    // Gemini output
    $("title-llm-card").textContent = "Gemini response";
    if (withLlm) {
        $("badge-model").textContent = data.llm_model || "";
        $("llm-output-text").textContent = data.llm_response || "No response received.";
    } else {
        $("badge-model").textContent = "";
        $("llm-output-text").textContent = `Gemini was skipped. ${engineName} decided in ${fmtMs(guardrailMs)}.`;
    }
}

async function runSideBySideBenchmark() {
    const promptText = $("bench-input").value.trim();
    showError("bench-error", "");
    if (!promptText) {
        showError("bench-error", "Enter a prompt to compare.");
        return;
    }

    const btn = $("btn-run-benchmark");
    btn.disabled = true;
    btn.textContent = "Running";
    $("bench-results-grid").hidden = false;
    ["bench-laya-ms", "bench-rag-ms"].forEach(id => { $(id).textContent = "..."; });
    setBadge($("bench-laya-verdict"), "", "Running");
    setBadge($("bench-rag-verdict"), "", "Running");
    $("bench-laya-bar").style.width = "0";
    $("bench-rag-bar").style.width = "0";
    $("bench-summary-box").textContent = "Running both guardrails.";

    try {
        const data = await postJson("/api/compare", { prompt: promptText });
        const l = data.laya, r = data.rag;
        $("bench-laya-ms").textContent = Number(l.latency_ms).toFixed(1);
        $("bench-rag-ms").textContent = Number(r.latency_ms).toFixed(1);
        setBadge($("bench-laya-verdict"), l.verdict === "SAFE" ? "passed" : "blocked", l.verdict === "SAFE" ? "Passed" : "Blocked");
        setBadge($("bench-rag-verdict"), r.verdict === "SAFE" ? "passed" : "blocked", r.verdict === "SAFE" ? "Passed" : "Blocked");
        const max = Math.max(l.latency_ms, r.latency_ms, 1);
        $("bench-laya-bar").style.width = `${Math.max(2, (l.latency_ms / max) * 100)}%`;
        $("bench-rag-bar").style.width = `${Math.max(2, (r.latency_ms / max) * 100)}%`;
        $("bench-summary-box").textContent = data.benchmark.speedup_factor;
    } catch (e) {
        $("bench-results-grid").hidden = true;
        showError("bench-error", e.message || "Comparison failed.");
    } finally {
        btn.disabled = false;
        btn.textContent = "Run comparison";
    }
}

async function loadDatasetSamples(shuffle = false) {
    const tbody = $("dataset-samples-body");
    tbody.innerHTML = `<tr><td colspan="3" class="muted center">Loading</td></tr>`;
    try {
        const res = await fetch(`/api/dataset/samples?limit=15&shuffle=${shuffle}`);
        if (!res.ok) throw new Error();
        cachedDatasetSamples = (await res.json()).samples || [];
        filterDatasetRows();
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="3" class="center" style="color: var(--danger);">Could not load the dataset.</td></tr>`;
    }
}

function renderDatasetRows(samples) {
    const tbody = $("dataset-samples-body");
    if (samples.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" class="muted center">No matching prompts.</td></tr>`;
        return;
    }
    tbody.innerHTML = samples.map(item => {
        const attack = item.label === 1;
        return `<tr>
            <td class="idx">${item.index}</td>
            <td><span class="badge ${attack ? "blocked" : "passed"}">${attack ? "Injection" : "Benign"}</span></td>
            <td>${escapeHtml(item.text)}</td>
        </tr>`;
    }).join("");
}

function filterDatasetRows() {
    const query = $("filter-samples-input").value.toLowerCase().trim();
    renderDatasetRows(query
        ? cachedDatasetSamples.filter(s => s.text.toLowerCase().includes(query) || (s.label_name || "").toLowerCase().includes(query))
        : cachedDatasetSamples);
}

function escapeHtml(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
