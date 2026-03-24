from pydantic import BaseModel

from services.chat import service


class ChatRequest(BaseModel):
    message:             str  = ""
    system:              str  = ""
    history:             list = []
    current_code:        str  = ""
    selected_sources:    list = []
    selected_indicators: list = []


class VisionChatRequest(BaseModel):
    message:      str = "Analyze this chart and create a trading strategy based on what you see."
    image_base64: str = ""
    mime_type:    str = "image/jpeg"
    system:       str = ""
    current_code: str = ""


def chat(req: ChatRequest):
    return service.generate_chat_response(
        req.message, req.system, req.history,
        req.current_code, req.selected_sources, req.selected_indicators,
    )


def chat_vision(req: VisionChatRequest):
    return service.generate_vision_response(
        req.message, req.image_base64, req.mime_type,
        req.system, req.current_code,
    )
