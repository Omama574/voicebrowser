document.addEventListener("DOMContentLoaded", () => {
    // 1. Tab Navigation
    const tabBtns = document.querySelectorAll(".tab-btn");
    const socViews = document.querySelectorAll(".soc-view");

    tabBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            const targetId = btn.getAttribute("data-target");
            tabBtns.forEach(b => b.classList.remove("active"));
            socViews.forEach(v => v.classList.remove("active"));

            btn.classList.add("active");
            document.getElementById(targetId).classList.add("active");

            if (targetId === "sec-explorer") {
                loadDatasetSamples(false);
            }
        });
    });

    // 2. Character Counter
    const promptInput = document.getElementById("prompt-input");
    const charCount = document.getElementById("char-count");

    if (promptInput && charCount) {
        promptInput.addEventListener("input", () => {
            charCount.textContent = `${promptInput.value.length} characters`;
        });
    }

    // 3. Key Config Persistence
    const keyInput = document.getElementById("gemini-key-input");
    const btnSaveKey = document.getElementById("btn-save-key");

    const savedKey = localStorage.getItem("gemini_api_key") || "";
    if (savedKey && keyInput) {
        keyInput.value = savedKey;
    }

    if (btnSaveKey) {
        btnSaveKey.addEventListener("click", () => {
            const val = keyInput ? keyInput.value.trim() : "";
            localStorage.setItem("gemini_api_key", val);
            btnSaveKey.textContent = "SAVED!";
            setTimeout(() => { btnSaveKey.textContent = "SAVE KEY"; }, 1500);
        });
    }

    // 4. Preset Chips Click Handler
    document.querySelectorAll(".chip").forEach(chip => {
        chip.addEventListener("click", () => {
            const text = chip.getAttribute("data-prompt");
            if (promptInput && text) {
                promptInput.value = text;
                promptInput.focus();
                if (charCount) charCount.textContent = `${text.length} characters`;
            }
        });
    });

    // 5. Initial Laya Info
    fetchLayaInfo();

    // 6. Execution Buttons (Laya vs Vector RAG)
    const btnEvalLaya = document.getElementById("btn-eval-laya");
    const btnExecLaya = document.getElementById("btn-exec-laya");
    const btnEvalRag = document.getElementById("btn-eval-rag");
    const btnExecRag = document.getElementById("btn-exec-rag");

    if (btnEvalLaya) btnEvalLaya.addEventListener("click", () => runPipeline("laya", false));
    if (btnExecLaya) btnExecLaya.addEventListener("click", () => runPipeline("laya", true));
    if (btnEvalRag) btnEvalRag.addEventListener("click", () => runPipeline("rag", false));
    if (btnExecRag) btnExecRag.addEventListener("click", () => runPipeline("rag", true));

    // 7. Copy LLM Response Button
    const btnCopy = document.getElementById("btn-copy-llm");
    if (btnCopy) {
        btnCopy.addEventListener("click", () => {
            const llmText = document.getElementById("llm-output-text").textContent;
            navigator.clipboard.writeText(llmText);
            btnCopy.textContent = "COPIED!";
            setTimeout(() => { btnCopy.textContent = "COPY RESPONSE"; }, 1500);
        });
    }

    // 8. Side-by-Side Benchmark Button
    const btnBench = document.getElementById("btn-run-benchmark");
    if (btnBench) {
        btnBench.addEventListener("click", runSideBySideBenchmark);
    }

    // 9. Dataset Search Filter & Refresh
    const btnRefresh = document.getElementById("btn-refresh-samples");
    const filterInput = document.getElementById("filter-samples-input");

    if (btnRefresh) {
        btnRefresh.addEventListener("click", () => loadDatasetSamples(true));
    }
    if (filterInput) {
        filterInput.addEventListener("input", filterDatasetRows);
    }
});

let cachedDatasetSamples = [];

async function fetchLayaInfo() {
    try {
        const res = await fetch("/api/laya/info");
        if (!res.ok) return;
        const data = await res.json();
        console.log("Laya Model Info:", data);
    } catch (e) {
        console.error("Failed to fetch Laya info:", e);
    }
}

async function runPipeline(engineType = "laya", executeLlm = true) {
    const promptInput = document.getElementById("prompt-input");
    const promptText = promptInput ? promptInput.value.trim() : "";

    if (!promptText) {
        alert("Please enter a prompt to evaluate.");
        return;
    }

    const keyInput = document.getElementById("gemini-key-input");
    const geminiKey = (keyInput ? keyInput.value.trim() : "") || localStorage.getItem("gemini_api_key") || "";

    const engineName = engineType === "laya" ? "Laya System 1" : "Vector RAG Guardrail";
    const endpoint = engineType === "laya" 
        ? (executeLlm ? "/api/laya/query" : "/api/laya/evaluate")
        : (executeLlm ? "/api/rag/query" : "/api/rag/evaluate");

    const noticeBox = document.getElementById("rag-latency-notice");
    if (noticeBox) {
        noticeBox.style.display = engineType === "rag" ? "block" : "none";
    }

    // Show Timing Banner & Findings
    document.getElementById("timing-banner").style.display = "flex";
    document.getElementById("findings-section").style.display = "grid";

    // Set Card Titles based on engineType
    const titleVerdict = document.getElementById("title-verdict-card");
    const titleInspector = document.getElementById("title-inspector-card");
    const hintInspector = document.getElementById("hint-inspector-card");
    const titleLlm = document.getElementById("title-llm-card");

    const jsonBox = document.getElementById("laya-json-output");
    const ragBox = document.getElementById("rag-chunks-output");

    if (engineType === "laya") {
        if (titleVerdict) titleVerdict.textContent = "⚡ LAYA SYSTEM 1 VERDICT";
        if (titleInspector) titleInspector.textContent = "⚡ LAYA STRUCTURED DECISION OUTPUT";
        if (hintInspector) hintInspector.textContent = "Typed Primitives (Choice/Noul)";
        if (titleLlm) titleLlm.textContent = "GEMINI LLM OUTPUT CONSOLE (POST-LAYA AUDIT)";

        if (jsonBox) jsonBox.style.display = "block";
        if (ragBox) ragBox.style.display = "none";
    } else {
        if (titleVerdict) titleVerdict.textContent = "🔍 VECTOR RAG SECURITY VERDICT";
        if (titleInspector) titleInspector.textContent = "🔍 VECTOR RAG RETRIEVED SIMILAR CHUNKS / PROMPTS";
        if (hintInspector) hintInspector.textContent = "Top Vector Cosine Similarity Matches (hlyn-labs dataset)";
        if (titleLlm) titleLlm.textContent = "GEMINI LLM OUTPUT CONSOLE (POST-VECTOR RAG AUDIT)";

        if (jsonBox) jsonBox.style.display = "none";
        if (ragBox) {
            ragBox.style.display = "flex";
            ragBox.innerHTML = `<div class="explanation-callout" style="color: var(--accent-cyan); border-left-color: var(--accent-cyan);">⏳ Retrieval In Progress: Searching Vector Database index for cosine similarity matches... (2.0s overhead)</div>`;
        }
    }

    document.getElementById("lbl-guardrail-time").textContent = `${engineName.toUpperCase()} TIME:`;
    document.getElementById("val-laya-time").textContent = "...";
    document.getElementById("val-llm-time").textContent = "...";
    document.getElementById("val-total-time").textContent = "...";

    document.getElementById("badge-verdict").className = "verdict-tag";
    document.getElementById("badge-verdict").textContent = "[PROCESSING...]";
    document.getElementById("box-explanation").textContent = `${engineName} audit pass in progress... (${engineType === 'rag' ? '2.0s Vector Index Overhead' : 'Sub-35ms Single Forward Pass'})`;
    if (jsonBox) jsonBox.textContent = "Evaluating prompt...";
    document.getElementById("llm-output-text").textContent = executeLlm ? "⏳ Executing Gemini LLM query..." : `ℹ️ [${engineName} Check Only]: Gemini LLM call bypassed.`;

    try {
        const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: promptText, gemini_api_key: geminiKey })
        });

        if (!res.ok) {
            const err = await res.json();
            alert(`Error: ${err.detail || 'Evaluation failed'}`);
            return;
        }

        const data = await res.json();
        renderPipelineResults(engineType, data, executeLlm);
    } catch (e) {
        console.error("Pipeline error:", e);
        alert(`Failed to connect to ${engineName} server.`);
    }
}

function renderPipelineResults(engineType, data, executeLlm) {
    const evalData = data.laya_evaluation || data.guardrail_evaluation || data;
    const isSafe = evalData.is_safe;
    const riskPercentage = evalData.risk_percentage !== undefined ? evalData.risk_percentage : (evalData.risk_score * 100).toFixed(1);
    
    const timings = data.timings || {
        laya_guardrail_time_ms: evalData.laya_execution_time_ms || 0.0,
        rag_guardrail_time_ms: evalData.rag_execution_time_ms || 0.0,
        gemini_llm_time_ms: 0.0,
        total_pipeline_time_ms: evalData.laya_execution_time_ms || evalData.rag_execution_time_ms || 0.0
    };

    const guardrailMs = timings.laya_guardrail_time_ms || timings.rag_guardrail_time_ms || evalData.laya_execution_time_ms || evalData.rag_execution_time_ms || 0.0;
    const llmMs = timings.gemini_llm_time_ms || 0.0;
    const totalMs = timings.total_pipeline_time_ms || (guardrailMs + llmMs);

    const engineName = engineType === "laya" ? "LAYA SYSTEM 1" : "VECTOR RAG";

    // Update Titles
    const titleVerdict = document.getElementById("title-verdict-card");
    const titleInspector = document.getElementById("title-inspector-card");
    const hintInspector = document.getElementById("hint-inspector-card");
    const titleLlm = document.getElementById("title-llm-card");

    if (engineType === "laya") {
        if (titleVerdict) titleVerdict.textContent = "⚡ LAYA SYSTEM 1 VERDICT";
        if (titleInspector) titleInspector.textContent = "⚡ LAYA STRUCTURED DECISION OUTPUT";
        if (hintInspector) hintInspector.textContent = "Typed Primitives (Choice/Noul)";
        if (titleLlm) titleLlm.textContent = "GEMINI LLM OUTPUT CONSOLE (POST-LAYA AUDIT)";
    } else {
        if (titleVerdict) titleVerdict.textContent = "🔍 VECTOR RAG SECURITY VERDICT";
        if (titleInspector) titleInspector.textContent = "🔍 VECTOR RAG RETRIEVED SIMILAR CHUNKS / PROMPTS";
        if (hintInspector) hintInspector.textContent = "Top Vector Cosine Similarity Matches (hlyn-labs dataset)";
        if (titleLlm) titleLlm.textContent = "GEMINI LLM OUTPUT CONSOLE (POST-VECTOR RAG AUDIT)";
    }

    // Render Timings Banner
    document.getElementById("lbl-guardrail-time").textContent = `${engineName} TIME:`;
    document.getElementById("val-laya-time").textContent = `${guardrailMs} ms`;
    document.getElementById("val-llm-time").textContent = `${llmMs} ms`;
    document.getElementById("val-total-time").textContent = `${totalMs} ms`;

    // Render Verdict Badge
    const badge = document.getElementById("badge-verdict");
    if (isSafe) {
        badge.className = "verdict-tag verdict-passed";
        badge.textContent = `[PASSED - AUTHENTIC] (${engineName})`;
    } else {
        badge.className = "verdict-tag verdict-blocked";
        badge.textContent = `[BLOCKED - PROMPT INJECTION] (${engineName})`;
    }

    // Render Risk Bar
    const fill = document.getElementById("risk-bar-fill");
    fill.style.width = `${Math.min(100, Math.max(0, riskPercentage))}%`;
    fill.style.backgroundColor = isSafe ? "var(--success)" : "var(--danger)";
    document.getElementById("txt-risk-score").textContent = `${riskPercentage}%`;

    // Render Explanation Callout
    const boxExp = document.getElementById("box-explanation");
    boxExp.textContent = evalData.explanation || `Verdict: ${evalData.verdict} (Risk Score: ${riskPercentage}%).`;
    boxExp.style.borderLeftColor = isSafe ? "var(--success)" : "var(--danger)";

    // Render Inspector Box: Laya JSON vs RAG Similar Chunks
    const jsonBox = document.getElementById("laya-json-output");
    const ragBox = document.getElementById("rag-chunks-output");

    if (engineType === "laya") {
        if (jsonBox) jsonBox.style.display = "block";
        if (ragBox) ragBox.style.display = "none";

        if (jsonBox) {
            jsonBox.textContent = JSON.stringify({
                engine: "LAYA SYSTEM 1",
                guardrail_latency_ms: `${guardrailMs} ms`,
                gemini_llm_latency_ms: `${llmMs} ms`,
                total_pipeline_latency_ms: `${totalMs} ms`,
                verdict: evalData.verdict,
                risk_score: evalData.risk_score,
                risk_percentage: `${riskPercentage}%`,
                decisions: evalData.laya_decisions || {
                    is_attack: isSafe ? "No" : "Yes",
                    threat_category: isSafe ? "benign_query" : "prompt_injection"
                }
            }, null, 2);
        }
    } else {
        if (jsonBox) jsonBox.style.display = "none";
        if (ragBox) ragBox.style.display = "flex";

        const matches = evalData.top_matches || [];
        if (ragBox) {
            if (matches.length === 0) {
                ragBox.innerHTML = `<div class="explanation-callout">No historical vector matches found.</div>`;
            } else {
                ragBox.innerHTML = matches.map((m, idx) => {
                    const isAttack = m.label === 1 || m.label_name === "PROMPT_INJECTION";
                    const badgeClass = isAttack ? "chip-attack" : "chip-safe";
                    const labelTitle = isAttack ? "[PROMPT_INJECTION]" : "[BENIGN_QUERY]";
                    const simPct = m.similarity !== undefined ? (m.similarity * 100).toFixed(1) : "N/A";
                    return `
                        <div class="chunk-card ${isAttack ? 'chunk-attack' : 'chunk-safe'}">
                            <div class="chunk-meta">
                                <span class="chip-badge ${badgeClass}">${labelTitle}</span>
                                <span class="chunk-similarity">Rank #${idx + 1} | ${simPct}% Vector Similarity</span>
                            </div>
                            <div class="chunk-text">"${escapeHtml(m.text)}"</div>
                        </div>
                    `;
                }).join("");
            }
        }
    }

    // Render Gemini LLM Console
    const llmOut = document.getElementById("llm-output-text");
    const modelBadge = document.getElementById("badge-model");

    if (executeLlm) {
        if (data.llm_model) {
            modelBadge.textContent = `MODEL: ${data.llm_model}`;
        }
        llmOut.textContent = data.llm_response || "No response received.";
    } else {
        llmOut.textContent = `ℹ️ [${engineName} Inspection Only]: Guardrail evaluated prompt in ${guardrailMs}ms. Gemini LLM call bypassed.`;
    }
}

async function runSideBySideBenchmark() {
    const input = document.getElementById("bench-input");
    const promptText = input ? input.value.trim() : "";

    if (!promptText) {
        alert("Please enter a prompt to benchmark.");
        return;
    }

    const grid = document.getElementById("bench-results-grid");
    grid.style.display = "grid";

    document.getElementById("bench-laya-ms").textContent = "...";
    document.getElementById("bench-rag-ms").textContent = "...";
    document.getElementById("bench-laya-verdict").textContent = "RUNNING";
    document.getElementById("bench-rag-verdict").textContent = "RUNNING";
    document.getElementById("bench-summary-box").textContent = "Executing side-by-side latency benchmark...";

    try {
        const res = await fetch("/api/compare", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: promptText })
        });

        if (!res.ok) {
            alert("Benchmark request failed.");
            return;
        }

        const data = await res.json();
        
        // Laya Card
        document.getElementById("bench-laya-ms").textContent = data.laya.latency_ms;
        const bLayaTag = document.getElementById("bench-laya-verdict");
        bLayaTag.className = data.laya.verdict === "SAFE" ? "verdict-tag verdict-passed" : "verdict-tag verdict-blocked";
        bLayaTag.textContent = data.laya.verdict;

        // RAG Card
        document.getElementById("bench-rag-ms").textContent = data.rag.latency_ms;
        const bRagTag = document.getElementById("bench-rag-verdict");
        bRagTag.className = data.rag.verdict === "SAFE" ? "verdict-tag verdict-passed" : "verdict-tag verdict-blocked";
        bRagTag.textContent = data.rag.verdict;

        // Summary Box
        document.getElementById("bench-summary-box").innerHTML = `
            🚀 <strong>BENCHMARK RESULT:</strong> ${data.benchmark.speedup_factor}<br>
            <span style="font-size: 0.85rem; color: var(--text-muted);">
            Laya Latency: <strong>${data.laya.latency_ms} ms</strong> vs Vector RAG Latency: <strong>${data.rag.latency_ms} ms</strong>
            </span>
        `;
    } catch (e) {
        console.error("Benchmark error:", e);
    }
}

async function loadDatasetSamples(shuffle = false) {
    const tbody = document.getElementById("dataset-samples-body");
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="3" class="text-muted text-center">Loading dataset vectors...</td></tr>`;

    try {
        const res = await fetch(`/api/dataset/samples?limit=15&shuffle=${shuffle ? 'true' : 'false'}`);
        if (!res.ok) return;
        const data = await res.json();
        cachedDatasetSamples = data.samples || [];
        renderDatasetRows(cachedDatasetSamples);
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="3" class="text-center" style="color: var(--danger);">Failed to load dataset vectors.</td></tr>`;
    }
}

function renderDatasetRows(samples) {
    const tbody = document.getElementById("dataset-samples-body");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (samples.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" class="text-muted text-center">No matching prompt vectors found.</td></tr>`;
        return;
    }

    samples.forEach(item => {
        const tr = document.createElement("tr");
        const isAttack = item.label === 1;
        const style = isAttack ? "color: var(--danger);" : "color: var(--success);";
        const tag = isAttack ? "[PROMPT_INJECTION]" : "[BENIGN]";

        tr.innerHTML = `
            <td>${item.index}</td>
            <td><strong style="${style}">${tag}</strong></td>
            <td>${escapeHtml(item.text)}</td>
        `;
        tbody.appendChild(tr);
    });
}

function filterDatasetRows() {
    const input = document.getElementById("filter-samples-input");
    const query = input ? input.value.toLowerCase().trim() : "";
    
    if (!query) {
        renderDatasetRows(cachedDatasetSamples);
        return;
    }

    const filtered = cachedDatasetSamples.filter(item => 
        item.text.toLowerCase().includes(query) || item.label_name.toLowerCase().includes(query)
    );
    renderDatasetRows(filtered);
}

function escapeHtml(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
