import os

from config import HAS_GEMINI, GEMINI_MODEL
from services.chat.utils import extract_code_from_reply, code_looks_complete, build_context_prompt


def generate_chat_response(message: str, system: str, history: list,
                            current_code: str, selected_sources: list,
                            selected_indicators: list) -> dict:
    if not HAS_GEMINI:
        return {"error": "google-genai not installed. Run: pip3 install google-genai", "reply": ""}

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        return {"error": "GEMINI_API_KEY not set",
                "reply": "⚠️ No Gemini API key found. Set: export GEMINI_API_KEY=your_key"}

    try:
        from google import genai as google_genai
        from google.genai import types as genai_types

        client = google_genai.Client(api_key=api_key)

        code_ctx = ""
        if current_code and current_code.strip():
            code_ctx = (
                f"\n\nThe user currently has the following Python strategy loaded in the editor:"
                f"\n```python\n{current_code.strip()}\n```"
                f"\nWhen asked to modify, improve, or fix, ALWAYS return a COMPLETE updated version "
                f"of the full function — never a partial snippet or skeleton."
            )

        if selected_sources or selected_indicators:
            base_prompt = build_context_prompt(selected_sources, selected_indicators)
        else:
            base_prompt = (
                "You are an expert quantitative trading strategy builder for a crypto backtesting platform.\n"
                "Always structure responses with three labelled sections:\n"
                "[Algorithm] — plain-English explanation (3-5 sentences)\n"
                "[Python Code] — complete def strategy(df, unlocks): ... returning list of trade dicts\n"
                "[Parameters] — key parameters with defaults and ranges"
            )

        system_prompt = (system or base_prompt) + code_ctx

        contents = []
        for h in history:
            if h.get("role") in ("user", "model") and h.get("text"):
                contents.append({"role": h["role"], "parts": [{"text": h["text"]}]})
        contents.append({"role": "user", "parts": [{"text": message}]})

        try:
            cfg = genai_types.GenerateContentConfig(
                system_instruction=system_prompt,
                temperature=0.2,
                thinking_config=genai_types.ThinkingConfig(thinking_budget=0),
            )
        except Exception:
            cfg = genai_types.GenerateContentConfig(
                system_instruction=system_prompt,
                temperature=0.2,
            )

        response = client.models.generate_content(model=GEMINI_MODEL, contents=contents, config=cfg)
        reply    = response.text or ""

        code = extract_code_from_reply(reply)
        if not code_looks_complete(code):
            fix_prompt = (
                "The Python code you just gave me is incomplete — it only contains a skeleton or stub. "
                "Please write the FULL, COMPLETE implementation of the strategy() function with ALL the "
                "actual trading logic, indicator calculations, entry/exit conditions, and trade construction. "
                "Do NOT use '# ...' or '# your logic here' placeholders — write every single line of real code. "
                "The function must work correctly when executed as-is."
            )
            fix_contents = contents + [
                {"role": "model", "parts": [{"text": reply}]},
                {"role": "user",  "parts": [{"text": fix_prompt}]},
            ]
            fix_response = client.models.generate_content(model=GEMINI_MODEL, contents=fix_contents, config=cfg)
            reply = fix_response.text or reply

        return {"reply": reply, "error": None}

    except Exception as e:
        return {"reply": "", "error": str(e)}


def generate_vision_response(message: str, image_base64: str, mime_type: str,
                              system: str, current_code: str) -> dict:
    if not HAS_GEMINI:
        return {"error": "google-genai not installed", "reply": ""}

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        return {"error": "GEMINI_API_KEY not set", "reply": ""}
    if not image_base64:
        return {"error": "No image provided", "reply": ""}

    try:
        import base64
        from google import genai as google_genai
        from google.genai import types as genai_types

        client   = google_genai.Client(api_key=api_key)
        code_ctx = ""
        if current_code and current_code.strip():
            code_ctx = f"\n\nCurrent editor code:\n```python\n{current_code.strip()}\n```"

        system_prompt = (system or (
            "You are an expert quantitative trading strategy builder. "
            "When a user shows you a chart, analyze the visible patterns — price action, "
            "indicators, trends, support/resistance, volume — and design a systematic trading "
            "strategy that captures the pattern you observe. "
            "Always structure responses with:\n"
            "[Algorithm] — plain-English explanation\n"
            "[Python Code] — complete def strategy(df, unlocks): ... returning list of trade dicts\n"
            "[Parameters] — tunable parameters"
        )) + code_ctx

        image_bytes    = base64.b64decode(image_base64)
        part_image     = genai_types.Part.from_bytes(data=image_bytes, mime_type=mime_type)
        part_text      = genai_types.Part.from_text(text=message)
        cfg            = genai_types.GenerateContentConfig(system_instruction=system_prompt, temperature=0.2)
        vision_contents = [genai_types.Content(role="user", parts=[part_image, part_text])]
        response       = client.models.generate_content(model=GEMINI_MODEL, contents=vision_contents, config=cfg)
        reply          = response.text

        code = extract_code_from_reply(reply)
        if not code_looks_complete(code):
            fix_prompt = (
                "The Python code you generated is a skeleton/stub. Write the FULL implementation with "
                "all real trading logic, indicator calculations, and trade construction. No placeholders."
            )
            fix_contents = vision_contents + [
                {"role": "model", "parts": [{"text": reply}]},
                {"role": "user",  "parts": [{"text": fix_prompt}]},
            ]
            response = client.models.generate_content(model=GEMINI_MODEL, contents=fix_contents, config=cfg)
            reply    = response.text

        return {"reply": reply, "error": None}

    except Exception as e:
        return {"reply": "", "error": str(e)}
