import { apiPost } from './client'
import type { ChatRequest, ChatResponse } from '@/types'

export const chatApi = {
  send: (req: ChatRequest) => apiPost<ChatResponse>('/chat', req),
  sendVision: (req: { message: string; image_base64: string; mime_type: string; system?: string; current_code?: string }) =>
    apiPost<ChatResponse>('/chat-vision', req),
}
