'use strict'

const crypto = require('crypto')
const fs = require('fs')
const net = require('net')
const path = require('path')

const OPCODE = Object.freeze({
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4,
})

const MAX_FRAME_BYTES = 16 * 1024 * 1024
const RETRY_MS = 5000

function readConfig(host, mod, logger) {
  const defaults = {
    clientId: '',
    details: 'Playing Sandustry',
    state: 'Using SandLoader',
    showElapsed: true,
    largeImage: '',
    largeText: 'Sandustry',
  }

  try {
    const userData = host && host.paths && host.paths.userData
    if (!userData) return defaults
    const file = path.join(userData, 'smln', 'config', mod.id + '.json')
    if (!fs.existsSync(file)) return defaults
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return defaults
    return { ...defaults, ...saved }
  } catch (error) {
    logger.warn('could not read mod settings: ' + error.message)
    return defaults
  }
}

function ipcEndpoints() {
  if (process.platform === 'win32') {
    return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`)
  }

  const prefixes = [
    process.env.XDG_RUNTIME_DIR,
    process.env.TMPDIR,
    process.env.TMP,
    process.env.TEMP,
    '/tmp',
  ].filter(Boolean)

  const uniquePrefixes = [...new Set(prefixes.map((p) => path.resolve(p)))]
  const endpoints = []
  for (const prefix of uniquePrefixes) {
    for (let i = 0; i < 10; i++) endpoints.push(path.join(prefix, `discord-ipc-${i}`))
  }
  return endpoints
}

function nonce() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return crypto.randomBytes(16).toString('hex')
}

class DiscordRpcClient {
  constructor(clientId, logger) {
    this.clientId = clientId
    this.logger = logger
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.ready = false
    this.stopped = false
    this.retryTimer = null
    this.activity = null
  }

  start() {
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    this.ready = false
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (this.socket) {
      try { this.socket.destroy() } catch (_) {}
      this.socket = null
    }
  }

  setActivity(activity) {
    this.activity = activity
    if (this.ready) this.sendActivity()
  }

  connect() {
    if (this.stopped || this.socket) return
    const endpoints = ipcEndpoints()
    this.tryEndpoint(endpoints, 0)
  }

  tryEndpoint(endpoints, index) {
    if (this.stopped || this.socket) return
    if (index >= endpoints.length) {
      this.scheduleRetry()
      return
    }

    const endpoint = endpoints[index]
    const socket = net.createConnection(endpoint)
    let connected = false

    socket.once('connect', () => {
      connected = true
      this.socket = socket
      this.buffer = Buffer.alloc(0)
      this.ready = false

      socket.on('data', (chunk) => this.onData(chunk))
      socket.on('error', (error) => {
        this.logger.debug('Discord IPC socket error: ' + error.message)
      })
      socket.once('close', () => this.onClose(socket))

      this.logger.info('connected to Discord IPC at ' + endpoint)
      this.send(OPCODE.HANDSHAKE, { v: 1, client_id: this.clientId })
    })

    socket.once('error', () => {
      if (connected) return
      try { socket.destroy() } catch (_) {}
      this.tryEndpoint(endpoints, index + 1)
    })
  }

  onClose(socket) {
    if (this.socket !== socket) return
    this.socket = null
    this.ready = false
    this.buffer = Buffer.alloc(0)
    if (!this.stopped) {
      this.logger.debug('Discord IPC disconnected; retrying')
      this.scheduleRetry()
    }
  }

  scheduleRetry() {
    if (this.stopped || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, RETRY_MS)
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])

    while (this.buffer.length >= 8) {
      const opcode = this.buffer.readInt32LE(0)
      const length = this.buffer.readUInt32LE(4)

      if (length > MAX_FRAME_BYTES) {
        this.logger.warn('Discord IPC sent an oversized frame; closing the connection')
        if (this.socket) this.socket.destroy()
        return
      }
      if (this.buffer.length < 8 + length) return

      const body = this.buffer.subarray(8, 8 + length)
      this.buffer = this.buffer.subarray(8 + length)

      let payload = null
      try {
        payload = JSON.parse(body.toString('utf8'))
      } catch (error) {
        this.logger.warn('Discord IPC returned invalid JSON: ' + error.message)
        continue
      }

      this.onPacket(opcode, payload)
    }
  }

  onPacket(opcode, payload) {
    if (opcode === OPCODE.PING) {
      this.send(OPCODE.PONG, payload)
      return
    }

    if (opcode === OPCODE.CLOSE) {
      const message = payload && payload.message ? ': ' + payload.message : ''
      this.logger.warn('Discord closed the RPC connection' + message)
      if (this.socket) this.socket.destroy()
      return
    }

    if (opcode !== OPCODE.FRAME || !payload) return

    if (payload.evt === 'READY') {
      this.ready = true
      this.logger.info('Discord Rich Presence is ready')
      this.sendActivity()
      return
    }

    if (payload.evt === 'ERROR') {
      const message = payload.data && payload.data.message
        ? payload.data.message
        : JSON.stringify(payload.data || payload)
      this.logger.warn('Discord RPC error: ' + message)
    }
  }

  sendActivity() {
    if (!this.ready || !this.socket || !this.activity) return
    this.send(OPCODE.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: {
        pid: process.pid,
        activity: this.activity,
      },
      nonce: nonce(),
    })
  }

  send(opcode, payload) {
    const socket = this.socket
    if (!socket || socket.destroyed) return false

    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    const header = Buffer.allocUnsafe(8)
    header.writeInt32LE(opcode, 0)
    header.writeUInt32LE(body.length, 4)

    try {
      socket.write(Buffer.concat([header, body]))
      return true
    } catch (error) {
      this.logger.warn('could not write to Discord IPC: ' + error.message)
      return false
    }
  }
}

module.exports.setup = ({ mod, logger, smln, host }) => {
  const config = readConfig(host, mod, logger)
  const clientId = String(config.clientId || '').trim()

  if (!/^\d{17,20}$/.test(clientId)) {
    logger.warn(
      'Discord Rich Presence is disabled: set a valid Discord Application ID in ' +
      'SandLoader Mods -> Discord Rich Presence -> Settings, then restart Sandustry.'
    )
    return {}
  }

  const activity = {
    type: 0,
    details: String(config.details || 'Playing Sandustry').slice(0, 128),
    state: String(config.state || 'Using SandLoader').slice(0, 128),
  }

  if (config.showElapsed !== false) {
    activity.timestamps = { start: Math.floor(Date.now() / 1000) }
  }

  const largeImage = String(config.largeImage || '').trim()
  const largeText = String(config.largeText || '').trim()
  if (largeImage) {
    activity.assets = { large_image: largeImage }
    if (largeText) activity.assets.large_text = largeText.slice(0, 128)
  }

  if (smln && smln.install && smln.install.version) {
    logger.info('Sandustry ' + smln.install.version + ' detected')
  }

  const rpc = new DiscordRpcClient(clientId, logger)
  rpc.setActivity(activity)
  rpc.start()

  const cleanup = () => rpc.stop()
  process.once('exit', cleanup)

  logger.info('Discord Rich Presence started')
  return {}
}
