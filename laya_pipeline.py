import time
import logging
from typing import Dict, Any, Optional
from laya_guardrail import LayaPromptGuardrail
from gemini_client import GeminiClient

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("LayaPipeline")

class LayaPipeline:
    """
    Laya System 1 Security Gateway Pipeline:
    1. Laya System 1 Model Prompt Audit (measures Laya Latency in ms)
    2. If Harmful -> BLOCKED (No LLM execution)
    3. If Safe -> Direct Gemini LLM Generation (measures Gemini Latency in ms)
    """
    def __init__(self, guardrail: LayaPromptGuardrail):
        self.guardrail = guardrail
        self.gemini_client = GeminiClient()

    def query(self, user_prompt: str, gemini_api_key: Optional[str] = None) -> Dict[str, Any]:
        pipeline_start = time.perf_counter()
        
        # Step 1: Laya System 1 Decision Engine Audit
        laya_eval = self.guardrail.evaluate_prompt(user_prompt)
        laya_time_ms = laya_eval["laya_execution_time_ms"]
        
        if not laya_eval["is_safe"]:
            total_time_ms = round((time.perf_counter() - pipeline_start) * 1000, 2)
            logger.warning(f"BLOCKED BY LAYA SYSTEM 1 ({laya_time_ms}ms): Prompt injection detected.")
            
            return {
                "status": "BLOCKED",
                "is_safe": False,
                "user_prompt": user_prompt,
                "laya_evaluation": laya_eval,
                "timings": {
                    "laya_guardrail_time_ms": laya_time_ms,
                    "gemini_llm_time_ms": 0.0,
                    "total_pipeline_time_ms": total_time_ms,
                    "speedup_summary": f"Laya blocked threat in {laya_time_ms}ms (Gemini LLM call skipped)."
                },
                "llm_response": (
                    f"⛔ [SECURITY REJECTION BY LAYA SYSTEM 1]: "
                    f"Prompt evaluated as PROMPT INJECTION in {laya_time_ms}ms. "
                    f"Execution stopped before calling Gemini LLM."
                ),
                "execution_summary": {
                    "laya_passed": False,
                    "llm_executed": False
                }
            }

        # Step 2: Safe Prompt -> Call Gemini LLM & Measure LLM Latency
        llm_start = time.perf_counter()
        llm_res = self.gemini_client.generate(prompt=user_prompt, api_key=gemini_api_key)
        gemini_time_ms = round((time.perf_counter() - llm_start) * 1000, 2)
        
        total_time_ms = round((time.perf_counter() - pipeline_start) * 1000, 2)
        
        return {
            "status": "PASSED",
            "is_safe": True,
            "user_prompt": user_prompt,
            "laya_evaluation": laya_eval,
            "timings": {
                "laya_guardrail_time_ms": laya_time_ms,
                "gemini_llm_time_ms": gemini_time_ms,
                "total_pipeline_time_ms": total_time_ms,
                "speedup_summary": f"Laya Guardrail: {laya_time_ms}ms | Gemini LLM: {gemini_time_ms}ms | Total: {total_time_ms}ms"
            },
            "llm_response": llm_res.get("text", "No response returned from LLM."),
            "llm_status": llm_res.get("status", "UNKNOWN"),
            "llm_model": llm_res.get("model", "gemini-3.8-flash"),
            "execution_summary": {
                "laya_passed": True,
                "llm_executed": True
            }
        }
