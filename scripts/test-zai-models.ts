/**
 * zai-models config file tests — layered loading (embedded ← global ← workspace),
 * merge semantics, replace mode, invalid-file fallback, adapter + provider info wiring.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  zaiModels, zaiModelsUserPath, EMBEDDED_ZAI_MODELS,
  ZaiAdapter, listProviderInfos, acceptsImages, defaultConfig,
} from '../packages/core/src/index'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean) => { cond ? pass++ : fail++; console.log(`${cond ? '✔' : '✗'} ${name}`) }

// isolated HOME so the global layer is under our control
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-zaihome-'))
process.env.HOME = home
const globalFile = path.join(home, '.tagent', 'zai-models.json')
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-zaiws-'))
const wsFile = path.join(ws, '.tagent', 'zai-models.json')

// ---- 1. embedded defaults ----
ok('embedded file parses with 4 models', EMBEDDED_ZAI_MODELS.length === 4)
ok('glm-4.7 first + labeled default', EMBEDDED_ZAI_MODELS[0]?.id === 'glm-4.7' && /default/i.test(EMBEDDED_ZAI_MODELS[0].label))
ok('vision flags set (4.7/4.6/4.5v true, air false)', EMBEDDED_ZAI_MODELS.find(m => m.id === 'glm-4.7')?.vision === true && EMBEDDED_ZAI_MODELS.find(m => m.id === 'glm-4.5-air')?.vision === false)
ok('provider stamped', EMBEDDED_ZAI_MODELS.every(m => m.provider === 'zai'))
ok('no file → zaiModels() = embedded', JSON.stringify(zaiModels()) === JSON.stringify(EMBEDDED_ZAI_MODELS))

// ---- 2. global override: merge ----
fs.mkdirSync(path.join(home, '.tagent'), { recursive: true })
fs.writeFileSync(globalFile, JSON.stringify({
  models: [
    { id: 'glm-4.7', label: 'GLM-4.7 (custom label)' },        // replaces in place
    { id: 'glm-5-preview', label: 'GLM-5 Preview', vision: true }, // appended
  ],
}, null, 2))
let models = zaiModels()
ok('global merge: same count-order base', models.length === 5 && models[0].id === 'glm-4.7')
ok('global merge: entry replaced in place', models[0].label === 'GLM-4.7 (custom label)')
ok('global merge: new id appended', models.some(m => m.id === 'glm-5-preview' && m.vision === true))
ok('label defaults to id when omitted', models.find(m => m.id === 'glm-5-preview')!.label === 'GLM-5 Preview')

// ---- 3. workspace override: layering on top of global ----
fs.mkdirSync(path.join(ws, '.tagent'), { recursive: true })
fs.writeFileSync(wsFile, JSON.stringify({
  models: [{ id: 'glm-5-preview', label: 'GLM-5 (workspace flavor)' }],
}, null, 2))
models = zaiModels(ws)
ok('workspace wins over global', models.find(m => m.id === 'glm-5-preview')?.label === 'GLM-5 (workspace flavor)')
ok('without root: global layer only', zaiModels().find(m => m.id === 'glm-5-preview')?.label === 'GLM-5 Preview')

// ---- 4. replace mode ----
fs.writeFileSync(wsFile, JSON.stringify({ replace: true, models: [{ id: 'glm-4.6' }] }, null, 2))
models = zaiModels(ws)
ok('replace=true → only the file models', models.length === 1 && models[0].id === 'glm-4.6')
ok('replace fallback label = id', models[0].label === 'glm-4.6')
ok('replace does not touch other roots', zaiModels().length === 5)

// ---- 5. invalid files never throw ----
fs.writeFileSync(wsFile, '{ this is not json')
ok('invalid JSON ignored (falls back)', zaiModels(ws).length === 5)
fs.writeFileSync(wsFile, JSON.stringify({ models: 'not-an-array' }))
ok('models not array ignored', zaiModels(ws).length === 5)
fs.writeFileSync(wsFile, JSON.stringify({ models: [{ nope: 1 }, null, { id: 'ok-one' }] }))
models = zaiModels(ws)
ok('entries without id skipped', models.some(m => m.id === 'ok-one') && models.length === 6)

// ---- 6. adapter + provider wiring ----
const adapter = new ZaiAdapter(ws)
ok('ZaiAdapter reads workspace layer', adapter.models.some(m => m.id === 'ok-one'))
ok('ZaiAdapter without root reads global', new ZaiAdapter().models.length === 5)
const infos = listProviderInfos(defaultConfig(), ws)
const zai = infos.find(p => p.id === 'zai')
ok('listProviderInfos(root) wired', zai?.models.some(m => m.id === 'ok-one'))
ok('listProviderInfos without root = global', listProviderInfos(defaultConfig()).find(p => p.id === 'zai')!.models.length === 5)

// ---- 7. vision semantics through acceptsImages ----
const clean = new ZaiAdapter(home)
fs.writeFileSync(globalFile, JSON.stringify({ replace: true, models: [
  { id: 'glm-x', vision: true }, { id: 'glm-y', vision: false }, { id: 'glm-z' },
] }))
const a2 = new ZaiAdapter(home)
ok('acceptsImages honors explicit true', acceptsImages(a2, 'glm-x') === true)
ok('acceptsImages honors explicit false', acceptsImages(a2, 'glm-y') === false)
ok('acceptsImages heuristic for unflagged glm-4.x', acceptsImages(a2, 'glm-4.9') === true)
ok('user path helper points at HOME', zaiModelsUserPath() === globalFile)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
