import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from '../util'

/**
 * Storage adapters — pluggable cloud/sync backends for snapshots, memory
 * backup, and cross-device settings.
 *
 * - LocalAdapter    : files under <root>/.tagent/storage (always available)
 * - MegaAdapter     : MEGA.nz, end-to-end encrypted (needs `bun add megajs`)
 */

export interface StorageAdapter {
  id: string
  label: string
  put(key: string, data: string | Buffer): Promise<void>
  get(key: string): Promise<Buffer>
  list(prefix?: string): Promise<string[]>
  delete(key: string): Promise<void>
}

export class LocalAdapter implements StorageAdapter {
  id = 'local'
  label = 'Local storage'
  constructor(private baseDir: string) {
    ensureDir(baseDir)
  }
  private file(key: string): string {
    const p = path.resolve(this.baseDir, key.replace(/\.\./g, '__'))
    if (p !== this.baseDir && !p.startsWith(this.baseDir + path.sep)) throw new Error('bad key')
    return p
  }
  async put(key: string, data: string | Buffer): Promise<void> {
    const f = this.file(key)
    ensureDir(path.dirname(f))
    fs.writeFileSync(f, data)
  }
  async get(key: string): Promise<Buffer> {
    return fs.readFileSync(this.file(key))
  }
  async list(prefix = ''): Promise<string[]> {
    const out: string[] = []
    const walkDir = (dir: string, rel: string) => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) walkDir(path.join(dir, e.name), r)
        else if (r.startsWith(prefix)) out.push(r)
      }
    }
    walkDir(this.baseDir, '')
    return out
  }
  async delete(key: string): Promise<void> {
    try { fs.rmSync(this.file(key)) } catch { /* noop */ }
  }
}

/**
 * MEGA.nz adapter — zero-knowledge end-to-end encrypted cloud storage.
 * Layout (created on first sync):
 *   /tagent/<workspace>/snapshots/**   checkpoint zips
 *   /tagent/<workspace>/memory/**      AGENTS.md + facts backup
 *
 * Requires the unofficial `megajs` package:
 *   bun add megajs
 * Configure in Settings → Storage (email + session key or password).
 */
export class MegaAdapter implements StorageAdapter {
  id = 'mega'
  label = 'MEGA.nz'
  private storage: any = null
  constructor(
    private email: string,
    private sessionKey: string,
  ) {}

  private async connect(): Promise<any> {
    if (this.storage) return this.storage
    let megajs: any
    try {
      megajs = await import('megajs')
    } catch {
      throw new Error('MEGA not available — install the SDK first: bun add megajs')
    }
    const storage = await new Promise((resolve, reject) => {
      const s = new megajs.Mega({
        email: this.email,
        password: this.sessionKey, // or account password
        keepAlive: false,
        autologin: true,
      })
      s.once('ready', () => resolve(s))
      s.once('error', (err: Error) => reject(err))
    })
    this.storage = storage
    return storage
  }

  private async dirFor(key: string): Promise<{ storage: any; node: any; name: string }> {
    const storage = await this.connect()
    const parts = key.split('/')
    const name = parts.pop() as string
    let node = storage.root
    for (const part of parts) {
      let next = (node.children ?? []).find((c: any) => c.name === part && c.directory)
      if (!next) {
        node = await new Promise((resolve, reject) => {
          node.mkdir(part, (err: Error | undefined, n: any) => (err ? reject(err) : resolve(n)))
        })
      } else {
        node = next
      }
    }
    return { storage, node, name }
  }

  async put(key: string, data: string | Buffer): Promise<void> {
    const { node, name } = await this.dirFor(`tagent/${key}`)
    await new Promise<void>((resolve, reject) => {
      const upload = node.upload({ name }, Buffer.isBuffer(data) ? data : Buffer.from(data))
      upload.once('complete', () => resolve())
      upload.once('error', (err: Error) => reject(err))
    })
  }
  async get(key: string): Promise<Buffer> {
    const { node, name } = await this.dirFor(`tagent/${key}`)
    const file = (node.children ?? []).find((c: any) => c.name === name && !c.directory)
    if (!file) throw new Error(`MEGA: ${key} not found`)
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      const stream = file.download()
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', () => resolve())
      stream.on('error', (err: Error) => reject(err))
    })
    return Buffer.concat(chunks)
  }
  async list(prefix = ''): Promise<string[]> {
    const { node } = await this.dirFor('tagent')
    const out: string[] = []
    const walk = (n: any, rel: string) => {
      for (const c of n.children ?? []) {
        const r = rel ? `${rel}/${c.name}` : c.name
        if (c.directory) walk(c, r)
        else if (r.startsWith(prefix)) out.push(r)
      }
    }
    walk(node, '')
    return out
  }
  async delete(key: string): Promise<void> {
    const { node, name } = await this.dirFor(`tagent/${key}`)
    const file = (node.children ?? []).find((c: any) => c.name === name)
    if (file) await new Promise<void>((r) => file.delete(true, () => r()))
  }
}

export function getStorageAdapter(
  root: string,
  mega?: { enabled: boolean; email?: string; sessionKey?: string },
): StorageAdapter {
  if (mega?.enabled && mega.email) {
    return new MegaAdapter(mega.email, mega.sessionKey ?? '')
  }
  return new LocalAdapter(path.join(root, '.tagent', 'storage'))
}
