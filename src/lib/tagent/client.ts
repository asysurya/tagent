'use client'

import { io, type Socket } from 'socket.io-client'
import type { HelloPayload } from './types'

/**
 * Tagent daemon client.
 * - Sandbox (NEXT_PUBLIC_DAEMON_PORT set): connect via gateway `?XTransformPort=`
 * - Local product: same-origin socket at /socket (daemon serves the GUI)
 */

const DAEMON_PORT = process.env.NEXT_PUBLIC_DAEMON_PORT
const SOCKET_PATH = process.env.NEXT_PUBLIC_DAEMON_SOCKET_PATH || '/socket'

export type TagentSocket = Socket

export function connectDaemon(): Socket {
  if (DAEMON_PORT) {
    // through the sandbox gateway — path must stay "/"
    const s = io(`/?XTransformPort=${DAEMON_PORT}`, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 6,
      reconnectionDelay: 1500,
      timeout: 8000,
    })
    s.on('connect_error', (err: Error) => console.warn('[tagent] connect_error:', err?.message))
    return s
  }
  return io({ path: SOCKET_PATH, transports: ['websocket', 'polling'], reconnection: true })
}

/** Promise-based request over the socket with ack. */
export function call<T>(socket: Socket, event: string, payload?: unknown, timeoutMs = 15000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} timed out`)), timeoutMs)
    socket.emit(event, payload, (res: T) => {
      clearTimeout(t)
      resolve(res)
    })
  })
}

export function hello(socket: Socket): Promise<HelloPayload> {
  return call<HelloPayload>(socket, 'hello', {}, 20000)
}
