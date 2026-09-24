import os from 'node:os'

/** LAN IPv4 addresses of this machine — for relay/`--host 0.0.0.0` hints. */
export function lanIPv4s(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
    }
  }
  return out
}
