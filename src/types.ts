export interface Instance {
  id: string
  name: string
  status: 'connecting' | 'connected' | 'disconnected' | 'error'
  owner?: string
  profileName?: string
  qrCode?: string
  pairingCode?: string
  webhookUrl?: string
  webhookEnabled: boolean
  createdAt: string
  updatedAt: string
}

export interface WebhookConfig {
  url: string
  enabled: boolean
  events: string[]
}

export interface SendTextPayload {
  to: string
  text: string
  quoted?: string
}

export interface SendMediaPayload {
  to: string
  mediaType: 'image' | 'audio' | 'video' | 'document' | 'sticker'
  url?: string
  base64?: string
  caption?: string
  fileName?: string
  mimetype?: string
  quoted?: string
}

export interface SendButtonPayload {
  to: string
  title: string
  description?: string
  footer?: string
  buttons: { id: string; text: string }[]
}

export interface SendListPayload {
  to: string
  title: string
  description?: string
  footer?: string
  buttonText: string
  sections: {
    title?: string
    rows: { id: string; title: string; description?: string }[]
  }[]
}

export interface CreateGroupPayload {
  name: string
  participants: string[]
}

export interface GroupActionPayload {
  groupJid: string
  participants: string[]
}

export interface InstanceStatus {
  id: string
  connected: boolean
  owner?: string
  profileName?: string
  battery?: number
  plugged?: boolean
  platform?: string
}

export interface ChatMessage {
  key: { id: string; remoteJid: string; fromMe: boolean }
  message?: {
    conversation?: string
    imageMessage?: any
    videoMessage?: any
    audioMessage?: any
    documentMessage?: any
    stickerMessage?: any
    extendedTextMessage?: { text: string }
  }
  messageTimestamp?: number
  pushName?: string
}

export interface Contact {
  jid: string
  name?: string
  notify?: string
  verifiedName?: string
  number: string
}

export interface GroupMetadata {
  id: string
  subject: string
  subjectOwner?: string
  subjectTime?: number
  size?: number
  creation?: number
  owner?: string
  desc?: string
  participants: { id: string; admin?: string | null }[]
}

export type WhatsAppEvent = {
  instanceId: string
  event: 'message' | 'presence' | 'connection'
  data: any
}
