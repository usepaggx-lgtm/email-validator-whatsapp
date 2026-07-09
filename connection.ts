import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, rmdirSync } from 'fs'
import { join } from 'path'
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import { EventEmitter } from 'events'
import { Instance, WebhookConfig, InstanceStatus, ChatMessage, Contact, GroupMetadata } from './types.js'

const SESSIONS_DIR = process.env.SESSIONS_DIR || join(process.cwd(), 'sessions')

if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true })

const instances = new Map<string, { sock: any; instance: Instance }>()
const webhooks = new Map<string, WebhookConfig>()
const eventBus = new EventEmitter()
eventBus.setMaxListeners(100)

function getSessionDir(instanceId: string): string {
  return join(SESSIONS_DIR, `session-${instanceId}`)
}

export function getEventBus() { return eventBus }

function getInstanceFile(instanceId: string): string {
  return join(SESSIONS_DIR, `${instanceId}-meta.json`)
}

function saveInstanceMeta(instance: Instance) {
  writeFileSync(getInstanceFile(instance.id), JSON.stringify(instance, null, 2))
}

function loadInstanceMeta(instanceId: string): Instance | null {
  const path = getInstanceFile(instanceId)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function deleteInstanceMeta(instanceId: string) {
  const path = getInstanceFile(instanceId)
  if (existsSync(path)) unlinkSync(path)
}

function loadAllInstances(): Instance[] {
  if (!existsSync(SESSIONS_DIR)) return []
  return readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('-meta.json'))
    .map(f => JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf-8')))
}

async function sendWebhook(instanceId: string, event: string, data: any) {
  const config = webhooks.get(instanceId)
  if (config?.enabled && config.url) {
    const payload = { instanceId, event, data, timestamp: new Date().toISOString() }
    if (config.events.length === 0 || config.events.includes(event)) {
      fetch(config.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {})
    }
  }
  eventBus.emit(`event:${instanceId}`, { event, data })
  eventBus.emit('event', { instanceId, event, data })
}

export async function createInstance(instanceId: string, name: string): Promise<Instance> {
  if (instances.has(instanceId)) {
    return instances.get(instanceId)!.instance
  }

  const instance: Instance = {
    id: instanceId, name,
    status: 'disconnected',
    webhookEnabled: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  saveInstanceMeta(instance)
  return instance
}

export async function connectInstance(instanceId: string): Promise<{ qrCode?: string; pairingCode?: string }> {
  if (instances.has(instanceId)) {
    const existing = instances.get(instanceId)!
    if (existing.instance.status === 'connected') return {}
    await disconnectInstance(instanceId)
  }

  const instance = loadInstanceMeta(instanceId)
  if (!instance) throw new Error('Instance not found')

  instance.status = 'connecting'
  saveInstanceMeta(instance)

  const sessionDir = getSessionDir(instanceId)
  if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
  const { version } = await fetchLatestBaileysVersion()

  let qrResolve: ((qr: string) => void) | null = null
  const qrPromise = new Promise<string>((resolve) => { qrResolve = resolve })

  const sock = makeWASocket({
    version,
    browser: Browsers.windows('Desktop'),
    auth: state,
    printQRInTerminal: true,
    syncFullHistory: false,
    markOnlineOnConnect: true,
  })

  let qrEmitted = false

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !qrEmitted) {
      qrEmitted = true
      instance.qrCode = qr
      instance.status = 'connecting'
      saveInstanceMeta(instance)
      qrResolve?.(qr)
      sendWebhook(instanceId, 'connection', { status: 'qr', qr })
    }

    if (connection === 'open') {
      const user = sock.user
      instance.status = 'connected'
      instance.owner = user?.id
      instance.profileName = user?.name || user?.verifiedName || ''
      instance.qrCode = undefined
      instance.updatedAt = new Date().toISOString()
      saveInstanceMeta(instance)
      sendWebhook(instanceId, 'connection', { status: 'connected', owner: user?.id })
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
      instance.status = 'disconnected'
      instance.qrCode = undefined
      instance.updatedAt = new Date().toISOString()
      saveInstanceMeta(instance)
      instances.delete(instanceId)
      sendWebhook(instanceId, 'connection', { status: 'disconnected', reconnect: shouldReconnect })

      if (shouldReconnect) {
        setTimeout(() => connectInstance(instanceId).catch(() => {}), 5000)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      const chatMsg = msg as any
      sendWebhook(instanceId, 'message', {
        key: chatMsg.key,
        message: chatMsg.message,
        pushName: chatMsg.pushName,
        messageTimestamp: chatMsg.messageTimestamp,
      })
    }
  })

  sock.ev.on('creds.update', saveCreds)

  instances.set(instanceId, { sock, instance })

  const qr = await qrPromise
  return { qrCode: qr }
}

export async function connectWithPairingCode(instanceId: string, phoneNumber: string): Promise<{ pairingCode: string }> {
  if (instances.has(instanceId)) {
    await disconnectInstance(instanceId)
  }

  const instance = loadInstanceMeta(instanceId)
  if (!instance) throw new Error('Instance not found')

  instance.status = 'connecting'
  saveInstanceMeta(instance)

  const sessionDir = getSessionDir(instanceId)
  if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    browser: Browsers.windows('Desktop'),
    auth: state,
    printQRInTerminal: true,
    syncFullHistory: false,
    markOnlineOnConnect: true,
  })

  let pairingCode = ''

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      const user = sock.user
      instance.status = 'connected'
      instance.owner = user?.id
      instance.profileName = user?.name || user?.verifiedName || ''
      instance.qrCode = undefined
      instance.pairingCode = undefined
      instance.updatedAt = new Date().toISOString()
      saveInstanceMeta(instance)
      sendWebhook(instanceId, 'connection', { status: 'connected', owner: user?.id })
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
      instance.status = 'disconnected'
      instance.qrCode = undefined
      instance.updatedAt = new Date().toISOString()
      saveInstanceMeta(instance)
      instances.delete(instanceId)
      sendWebhook(instanceId, 'connection', { status: 'disconnected', reconnect: shouldReconnect })

      if (shouldReconnect) {
        setTimeout(() => connectInstance(instanceId).catch(() => {}), 5000)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      const chatMsg = msg as any
      sendWebhook(instanceId, 'message', {
        key: chatMsg.key,
        message: chatMsg.message,
        pushName: chatMsg.pushName,
        messageTimestamp: chatMsg.messageTimestamp,
      })
    }
  })

  sock.ev.on('creds.update', saveCreds)

  if (!sock.authState.creds.registered) {
    const code = await sock.requestPairingCode(phoneNumber)
    pairingCode = code
    instance.pairingCode = code
    saveInstanceMeta(instance)
  }

  instances.set(instanceId, { sock, instance })

  return { pairingCode }
}

export async function disconnectInstance(instanceId: string) {
  const entry = instances.get(instanceId)
  if (entry) {
    try { entry.sock.ws?.close() } catch {}
    try { entry.sock.end(undefined) } catch {}
    instances.delete(instanceId)
  }
  const instance = loadInstanceMeta(instanceId)
  if (instance) {
    instance.status = 'disconnected'
    instance.qrCode = undefined
    instance.updatedAt = new Date().toISOString()
    saveInstanceMeta(instance)
  }
}

export async function deleteInstance(instanceId: string) {
  await disconnectInstance(instanceId)
  const sessionDir = getSessionDir(instanceId)
  if (existsSync(sessionDir)) {
    const files = readdirSync(sessionDir)
    for (const f of files) unlinkSync(join(sessionDir, f))
    rmdirSync(sessionDir)
  }
  deleteInstanceMeta(instanceId)
}

export function getInstanceStatus(instanceId: string): InstanceStatus | null {
  const entry = instances.get(instanceId)
  const meta = loadInstanceMeta(instanceId)
  if (!meta) return null

  return {
    id: instanceId,
    connected: entry?.instance.status === 'connected' || false,
    owner: meta.owner,
    profileName: meta.profileName,
  }
}

export function listInstances(): Instance[] {
  const metas = loadAllInstances()
  for (const m of metas) {
    const entry = instances.get(m.id)
    if (entry) {
      m.status = entry.instance.status
      m.owner = entry.instance.owner
      m.profileName = entry.instance.profileName
    }
  }
  return metas
}

export async function restartFailedInstances() {
  const metas = loadAllInstances()
  for (const m of metas) {
    if (m.status === 'connected' && !instances.has(m.id)) {
      try { await connectInstance(m.id) } catch {}
    }
  }
}

export function getSocket(instanceId: string) {
  const entry = instances.get(instanceId)
  if (!entry || !entry.sock?.user) throw new Error('Instance not connected')
  return entry.sock
}

export async function sendTextMessage(instanceId: string, to: string, text: string) {
  const sock = getSocket(instanceId)
  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`
  const result = await sock.sendMessage(jid, { text })
  return result
}

export async function sendMediaMessage(instanceId: string, to: string, params: { mediaType: string; url?: string; base64?: string; caption?: string; fileName?: string; mimetype?: string }) {
  const sock = getSocket(instanceId)
  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`

  let content: any = {}
  if (params.url) {
    const res = await fetch(params.url)
    const buffer = await res.arrayBuffer()
    const ext = params.mediaType === 'image' ? 'png' : params.mediaType === 'audio' ? 'mp3' : params.mediaType === 'video' ? 'mp4' : 'pdf'
    content[params.mediaType === 'sticker' ? 'sticker' : `${params.mediaType}Message`] = Buffer.from(buffer)
    if (params.caption) content.caption = params.caption
    if (params.fileName) content.fileName = params.fileName
    if (params.mimetype) content.mimetype = params.mimetype
  }

  const result = await sock.sendMessage(jid, content)
  return result
}

export async function sendButtons(instanceId: string, to: string, title: string, buttons: { id: string; text: string }[], description?: string, footer?: string) {
  const sock = getSocket(instanceId)
  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`
  const result = await sock.sendMessage(jid, {
    text: title,
    footer: footer,
    buttons: buttons.map(b => ({ buttonId: b.id, buttonText: { displayText: b.text }, type: 1 })),
    headerType: 1,
  } as any)
  return result
}

export async function sendListMessage(instanceId: string, to: string, title: string, buttonText: string, sections: { title?: string; rows: { id: string; title: string; description?: string }[] }[], description?: string, footer?: string) {
  const sock = getSocket(instanceId)
  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`
  const result = await sock.sendMessage(jid, {
    text: title,
    footer: footer,
    title: description,
    buttonText,
    sections: sections.map(s => ({
      title: s.title || '',
      rows: s.rows.map(r => ({ rowId: r.id, title: r.title, description: r.description })),
    })),
  } as any)
  return result
}

export async function getChats(instanceId: string) {
  const sock = getSocket(instanceId)
  const chats = sock.chats?.all() || []
  return chats.map((c: any) => ({
    jid: c.id,
    name: c.name || c.subject || '',
    unreadCount: c.unreadCount || 0,
    lastMessage: c.lastMessage ? {
      text: c.lastMessage?.message?.conversation ||
            c.lastMessage?.message?.extendedTextMessage?.text || '',
      timestamp: c.lastMessage?.messageTimestamp,
      fromMe: c.lastMessage?.key?.fromMe,
    } : null,
  })).filter((c: any) => !c.jid.endsWith('@broadcast'))
}

export async function getMessages(instanceId: string, jid: string, limit: number = 50) {
  const sock = getSocket(instanceId)
  const chatJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`
  const messages = await sock.loadMessages(chatJid, limit)
  return messages.map((m: any) => ({
    key: m.key,
    message: m.message,
    pushName: m.pushName,
    messageTimestamp: m.messageTimestamp,
  }))
}

export async function sendPresenceUpdate(instanceId: string, jid: string, presence: 'composing' | 'recording' | 'available') {
  const sock = getSocket(instanceId)
  await sock.sendPresenceUpdate(presence, jid)
}

export async function getContacts(instanceId: string) {
  const sock = getSocket(instanceId)
  const contacts = Object.values(sock.contacts || {}).filter((c: any) => !c.id.endsWith('@broadcast') && !c.id.endsWith('@g.us'))
  return contacts.map((c: any) => ({
    jid: c.id,
    name: c.name || c.notify || c.verifiedName || '',
    number: c.id.split('@')[0],
    notify: c.notify,
    verifiedName: c.verifiedName,
  }))
}

export async function checkNumber(instanceId: string, number: string) {
  const sock = getSocket(instanceId)
  const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`
  const [result] = await sock.onWhatsApp(jid)
  return { exists: !!result, jid: result?.jid || null }
}

export async function createGroup(instanceId: string, name: string, participants: string[]) {
  const sock = getSocket(instanceId)
  const jids = participants.map(p => p.includes('@') ? p : `${p}@s.whatsapp.net`)
  const result = await sock.groupCreate(name, jids)
  return { id: result.id, subject: result.subject || name }
}

export async function addGroupParticipants(instanceId: string, groupJid: string, participants: string[]) {
  const sock = getSocket(instanceId)
  const jids = participants.map(p => p.includes('@') ? p : `${p}@s.whatsapp.net`)
  const result = await sock.groupParticipantsUpdate(groupJid, jids, 'add')
  return result
}

export async function removeGroupParticipants(instanceId: string, groupJid: string, participants: string[]) {
  const sock = getSocket(instanceId)
  const jids = participants.map(p => p.includes('@') ? p : `${p}@s.whatsapp.net`)
  const result = await sock.groupParticipantsUpdate(groupJid, jids, 'remove')
  return result
}

export async function promoteGroupParticipants(instanceId: string, groupJid: string, participants: string[]) {
  const sock = getSocket(instanceId)
  const jids = participants.map(p => p.includes('@') ? p : `${p}@s.whatsapp.net`)
  const result = await sock.groupParticipantsUpdate(groupJid, jids, 'promote')
  return result
}

export async function demoteGroupParticipants(instanceId: string, groupJid: string, participants: string[]) {
  const sock = getSocket(instanceId)
  const jids = participants.map(p => p.includes('@') ? p : `${p}@s.whatsapp.net`)
  const result = await sock.groupParticipantsUpdate(groupJid, jids, 'demote')
  return result
}

export async function getGroupMetadata(instanceId: string, groupJid: string): Promise<GroupMetadata> {
  const sock = getSocket(instanceId)
  const meta = await sock.groupMetadata(groupJid)
  return {
    id: meta.id,
    subject: meta.subject,
    subjectOwner: meta.subjectOwner,
    subjectTime: meta.subjectTime,
    size: meta.size,
    creation: meta.creation,
    owner: meta.owner,
    desc: meta.desc,
    participants: (meta.participants || []).map((p: any) => ({
      id: p.id,
      admin: p.admin || null,
    })),
  }
}

export async function getGroupInviteCode(instanceId: string, groupJid: string) {
  const sock = getSocket(instanceId)
  const code = await sock.groupInviteCode(groupJid)
  return { inviteCode: code, inviteLink: `https://chat.whatsapp.com/${code}` }
}

export async function leaveGroup(instanceId: string, groupJid: string) {
  const sock = getSocket(instanceId)
  await sock.groupLeave(groupJid)
  return { success: true }
}

export async function setWebhook(instanceId: string, url: string, enabled: boolean, events: string[]) {
  webhooks.set(instanceId, { url, enabled, events })
  const instance = loadInstanceMeta(instanceId)
  if (instance) {
    instance.webhookUrl = url
    instance.webhookEnabled = enabled
    saveInstanceMeta(instance)
  }
  return { success: true }
}

export function getWebhook(instanceId: string): WebhookConfig | null {
  return webhooks.get(instanceId) || null
}

export async function readMessages(instanceId: string, jid: string, keys: { id: string; fromMe: boolean }[]) {
  const sock = getSocket(instanceId)
  await sock.readMessages(keys.map(k => ({ id: k.id, remoteJid: jid, fromMe: k.fromMe } as any)))
  return { success: true }
}

export async function sendSeen(instanceId: string, jid: string) {
  const sock = getSocket(instanceId)
  await sock.sendPresenceUpdate('available', jid)
  return { success: true }
}

export async function getProfilePicture(instanceId: string, jid: string) {
  const sock = getSocket(instanceId)
  try {
    const ppUrl = await sock.profilePictureUrl(jid, 'image')
    return { url: ppUrl }
  } catch {
    return { url: null }
  }
}
