import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import * as whatsapp from './connection.js'

const app = new Hono()
app.use('/*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowHeaders: ['Content-Type', 'Authorization'] }))

const API_KEY = process.env.WHATSAPP_API_KEY || 'dev-key'

function auth(c: any) {
  const key = c.req.header('x-api-key') || c.req.query('api_key')
  return key === API_KEY
}

function requireAuth(c: any) {
  if (!auth(c)) return c.json({ error: 'Unauthorized' }, 401)
}

app.use('/api/*', async (c, next) => {
  if (!auth(c)) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

app.get('/health', (c) => c.json({ status: 'ok', uptime: process.uptime() }))

app.post('/api/instance/create', async (c) => {
  const { id, name } = await c.req.json()
  if (!id || !name) return c.json({ error: 'id and name required' }, 400)
  const instance = await whatsapp.createInstance(id, name)
  return c.json({ instance })
})

app.post('/api/instance/connect', async (c) => {
  const { id } = await c.req.json()
  if (!id) return c.json({ error: 'id required' }, 400)
  try {
    const result = await whatsapp.connectInstance(id)
    return c.json(result)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/instance/pairing', async (c) => {
  const { id, phoneNumber } = await c.req.json()
  if (!id || !phoneNumber) return c.json({ error: 'id and phoneNumber required' }, 400)
  try {
    const result = await whatsapp.connectWithPairingCode(id, phoneNumber)
    return c.json(result)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/instance/disconnect', async (c) => {
  const { id } = await c.req.json()
  await whatsapp.disconnectInstance(id)
  return c.json({ success: true })
})

app.delete('/api/instance/:id', async (c) => {
  const id = c.req.param('id')
  await whatsapp.deleteInstance(id)
  return c.json({ success: true })
})

app.get('/api/instance/:id/status', async (c) => {
  const id = c.req.param('id')
  const status = whatsapp.getInstanceStatus(id)
  if (!status) return c.json({ error: 'Instance not found' }, 404)
  return c.json({ status })
})

app.get('/api/instances', async (c) => {
  const instances = whatsapp.listInstances()
  return c.json({ instances })
})

app.post('/api/message/text', async (c) => {
  const { id, to, text } = await c.req.json()
  if (!id || !to || !text) return c.json({ error: 'id, to and text required' }, 400)
  try {
    const result = await whatsapp.sendTextMessage(id, to, text)
    return c.json({ result })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/message/media', async (c) => {
  const { id, to, ...mediaParams } = await c.req.json()
  if (!id || !to) return c.json({ error: 'id and to required' }, 400)
  try {
    const result = await whatsapp.sendMediaMessage(id, to, mediaParams)
    return c.json({ result })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/message/buttons', async (c) => {
  const { id, to, title, buttons, description, footer } = await c.req.json()
  if (!id || !to || !title || !buttons) return c.json({ error: 'id, to, title and buttons required' }, 400)
  try {
    const result = await whatsapp.sendButtons(id, to, title, buttons, description, footer)
    return c.json({ result })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/message/list', async (c) => {
  const { id, to, title, buttonText, sections, description, footer } = await c.req.json()
  if (!id || !to || !title || !buttonText || !sections) return c.json({ error: 'id, to, title, buttonText and sections required' }, 400)
  try {
    const result = await whatsapp.sendListMessage(id, to, title, buttonText, sections, description, footer)
    return c.json({ result })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/message/read', async (c) => {
  const { id, jid, keys } = await c.req.json()
  if (!id || !jid || !keys) return c.json({ error: 'id, jid and keys required' }, 400)
  try {
    const result = await whatsapp.readMessages(id, jid, keys)
    return c.json(result)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/message/seen', async (c) => {
  const { id, jid } = await c.req.json()
  if (!id || !jid) return c.json({ error: 'id and jid required' }, 400)
  try {
    const result = await whatsapp.sendSeen(id, jid)
    return c.json(result)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.get('/api/chats/:id', async (c) => {
  const id = c.req.param('id')
  try {
    const chats = await whatsapp.getChats(id)
    return c.json({ chats })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.get('/api/messages/:id/:jid', async (c) => {
  const id = c.req.param('id')
  const jid = decodeURIComponent(c.req.param('jid'))
  const limit = parseInt(c.req.query('limit') || '50')
  try {
    const messages = await whatsapp.getMessages(id, jid, limit)
    return c.json({ messages })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.get('/api/contacts/:id', async (c) => {
  const id = c.req.param('id')
  try {
    const contacts = await whatsapp.getContacts(id)
    return c.json({ contacts })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/contacts/check', async (c) => {
  const { id, number } = await c.req.json()
  if (!id || !number) return c.json({ error: 'id and number required' }, 400)
  try {
    const result = await whatsapp.checkNumber(id, number)
    return c.json(result)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/group/create', async (c) => {
  const { id, name, participants } = await c.req.json()
  if (!id || !name) return c.json({ error: 'id and name required' }, 400)
  try {
    const result = await whatsapp.createGroup(id, name, participants || [])
    return c.json(result)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/group/add', async (c) => {
  const { id, groupJid, participants } = await c.req.json()
  if (!id || !groupJid || !participants) return c.json({ error: 'id, groupJid and participants required' }, 400)
  try {
    const result = await whatsapp.addGroupParticipants(id, groupJid, participants)
    return c.json({ result })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/group/remove', async (c) => {
  const { id, groupJid, participants } = await c.req.json()
  if (!id || !groupJid || !participants) return c.json({ error: 'id, groupJid and participants required' }, 400)
  try {
    const result = await whatsapp.removeGroupParticipants(id, groupJid, participants)
    return c.json({ result })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/group/promote', async (c) => {
  const { id, groupJid, participants } = await c.req.json()
  if (!id || !groupJid || !participants) return c.json({ error: 'id, groupJid and participants required' }, 400)
  try {
    const result = await whatsapp.promoteGroupParticipants(id, groupJid, participants)
    return c.json({ result })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/group/demote', async (c) => {
  const { id, groupJid, participants } = await c.req.json()
  if (!id || !groupJid || !participants) return c.json({ error: 'id, groupJid and participants required' }, 400)
  try {
    const result = await whatsapp.demoteGroupParticipants(id, groupJid, participants)
    return c.json({ result })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.get('/api/group/:id/:groupJid', async (c) => {
  const id = c.req.param('id')
  const groupJid = decodeURIComponent(c.req.param('groupJid'))
  try {
    const metadata = await whatsapp.getGroupMetadata(id, groupJid)
    return c.json(metadata)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.get('/api/group/invite/:id/:groupJid', async (c) => {
  const id = c.req.param('id')
  const groupJid = decodeURIComponent(c.req.param('groupJid'))
  try {
    const result = await whatsapp.getGroupInviteCode(id, groupJid)
    return c.json(result)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/group/leave', async (c) => {
  const { id, groupJid } = await c.req.json()
  if (!id || !groupJid) return c.json({ error: 'id and groupJid required' }, 400)
  try {
    const result = await whatsapp.leaveGroup(id, groupJid)
    return c.json(result)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/webhook/set', async (c) => {
  const { id, url, enabled, events } = await c.req.json()
  if (!id || !url) return c.json({ error: 'id and url required' }, 400)
  const result = await whatsapp.setWebhook(id, url, enabled ?? true, events || [])
  return c.json(result)
})

app.get('/api/webhook/:id', async (c) => {
  const id = c.req.param('id')
  const config = whatsapp.getWebhook(id)
  return c.json({ config })
})

app.get('/api/profile-picture/:id/:jid', async (c) => {
  const id = c.req.param('id')
  const jid = decodeURIComponent(c.req.param('jid'))
  try {
    const result = await whatsapp.getProfilePicture(id, jid)
    return c.json(result)
  } catch {
    return c.json({ url: null })
  }
})

app.get('/api/events/:id/stream', async (c) => {
  const id = c.req.param('id')
  const bus = whatsapp.getEventBus()

  return streamSSE(c, async (stream) => {
    const listener = (data: any) => {
      stream.writeSSE({ data: JSON.stringify(data), event: 'message' })
    }

    bus.on(`event:${id}`, listener)

    stream.onAbort(() => {
      bus.off(`event:${id}`, listener)
    })

    while (true) {
      await stream.sleep(30000)
      stream.writeSSE({ data: 'keepalive', event: 'ping' })
    }
  })
})

const PORT = parseInt(process.env.PORT || '3003')
console.log(`WhatsApp service running on port ${PORT}`)
serve({ fetch: app.fetch, port: PORT })
