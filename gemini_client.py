import os
import urllib.request
import json
import logging
from typing import Dict, Any, Optional

logger = logging.getLogger("GeminiClient")

def load_env_file():
    """Reads .env file in project directory if present."""
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, val = line.split("=", 1)
                    os.environ[key.strip()] = val.strip()

# Initialize environment variables
load_env_file()

class GeminiClient:
    """
    Direct client for Google Gemini REST API.
    Uses gemini-3.8-flash (with fallbacks to gemini-3.6-flash, gemini-3.5-flash, gemini-2.5-pro).
    """
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.environ.get("GEMINI_API_KEY", "")

    def set_api_key(self, api_key: str):
        if api_key:
            self.api_key = api_key.strip()

    def generate(self, prompt: str, system_instruction: Optional[str] = None, api_key: Optional[str] = None) -> Dict[str, Any]:
        key = (os.environ.get("GEMINI_API_KEY", "") or self.api_key or "").strip()  # server-side key only
        
        if not key:
            return {
                "status": "NO_API_KEY",
                "text": "⚠️ [Gemini API Key Required]: Set GEMINI_API_KEY in the server's .env file."
            }

        # Fastest-responding models first; 3.8 is the preferred model but is often overloaded (503)
        models_to_try = [
            "gemini-3.8-flash",
            "gemini-3.6-flash",
            "gemini-3.5-flash",
            "gemini-3.1-flash-lite",
            "gemini-3-flash-preview",
            "gemini-flash-latest"
        ]
        last_error = ""

        payload = {"contents": [{"parts": [{"text": prompt}]}]}
        if system_instruction:
            payload["systemInstruction"] = {"parts": [{"text": system_instruction}]}
        data_bytes = json.dumps(payload).encode("utf-8")

        for model in models_to_try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
            try:
                req = urllib.request.Request(
                    url,
                    data=data_bytes,
                    headers={"Content-Type": "application/json"},
                    method="POST"
                )

                with urllib.request.urlopen(req, timeout=12) as resp:
                    body = json.loads(resp.read().decode("utf-8"))
                    candidates = body.get("candidates", [])
                    if candidates:
                        parts = candidates[0].get("content", {}).get("parts", [])
                        text_out = "".join([p.get("text", "") for p in parts])
                        return {
                            "status": "SUCCESS",
                            "model": model,
                            "text": text_out
                        }
                    last_error = f"{model}: empty response"
            except urllib.error.HTTPError as e:
                err_body = e.read().decode("utf-8")
                logger.warning(f"Gemini API model '{model}' HTTP Error {e.code}: {err_body[:300]}")
                last_error = f"{model}: HTTP {e.code}"
                if e.code in (400, 403) and ("API key not valid" in err_body or "API_KEY_INVALID" in err_body):
                    return {
                        "status": "INVALID_KEY",
                        "text": "❌ Invalid Gemini API Key configured on the server (.env)."
                    }
                continue
            except Exception as e:
                logger.warning(f"Error calling Gemini model '{model}': {e}")
                last_error = f"{model}: {type(e).__name__}"
                continue

        return {
            "status": "ERROR",
            "text": f"Error calling Gemini API ({last_error}). All models failed; please retry."
        }
