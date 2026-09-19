'use client'

import { io, type Socket } from 'socket.io-client'
import type { HelloPayload, McpServerStatus, McpTemplate, PluginMeta } from './types'

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

/** Promise-based request over the socket with ack.
 *  timeoutMs <= 0 → no timer (fire-and-forget ack; for RPCs whose reply can
 *  legitimately arrive long after the action, e.g. chat:send). */
export function call<T>(socket: Socket, event: string, payload?: unknown, timeoutMs = 15000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = timeoutMs > 0 ? setTimeout(() => reject(new Error(`${event} timed out`)), timeoutMs) : null
    socket.emit(event, payload, (res: T) => {
      if (t) clearTimeout(t)
      resolve(res)
    })
  })
}

export function hello(socket: Socket): Promise<HelloPayload> {
  return call<HelloPayload>(socket, 'hello', {}, 20000)
}

/* ------------------------------- MCP -------------------------------- */

export function mcpList(socket: Socket): Promise<{ status: McpServerStatus[] }> {
  return call(socket, 'mcp:list', {}, 10000)
}

export function mcpEnsure(socket: Socket): Promise<{ status: McpServerStatus[] }> {
  return call(socket, 'mcp:ensure', {}, 60000)
}

export function mcpTemplates(socket: Socket): Promise<{ templates: McpTemplate[] }> {
  return call(socket, 'mcp:templates', {}, 10000)
}

export function mcpSave(
  socket: Socket,
  server: { name: string; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean },
): Promise<{ ok?: boolean; error?: string; status?: McpServerStatus[] }> {
  return call(socket, 'mcp:save', server, 90000)
}

export function mcpRemove(socket: Socket, name: string): Promise<{ ok?: boolean; error?: string }> {
  return call(socket, 'mcp:remove', { name }, 30000)
}

export function mcpToggle(socket: Socket, name: string): Promise<{ ok?: boolean; error?: string; enabled?: boolean }> {
  return call(socket, 'mcp:toggle', { name }, 60000)
}

/* ----------------------------- plugins ------------------------------ */

export function pluginsList(socket: Socket): Promise<{ plugins: PluginMeta[] }> {
  return call(socket, 'plugins:list', {}, 10000)
}

export function pluginScaffold(socket: Socket, name: string): Promise<{ ok?: boolean; file?: string; error?: string }> {
  return call(socket, 'plugins:scaffold', { name }, 15000)
}
