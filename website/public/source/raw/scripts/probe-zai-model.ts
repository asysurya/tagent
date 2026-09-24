/** quick probe: does z-ai-web-dev-sdk accept a `model` param, and which model answers by default? */
import ZAI from 'z-ai-web-dev-sdk'

async function main() {
  const zai = await ZAI.create()
  // 1) default model — what does the SDK use?
  try {
    const r = await zai.chat.completions.create({
      messages: [{ role: 'user', content: 'reply with the single word: ok' }],
      thinking: { type: 'disabled' },
    })
    console.log('default → model field:', JSON.stringify(r?.model ?? '(none)'), '| content:', r?.choices?.[0]?.message?.content?.slice(0, 40))
  } catch (e) {
    console.log('default call failed:', (e as Error).message)
  }
  // 2) explicit model param — accepted or rejected?
  for (const m of ['glm-4.7', 'glm-4.6', 'glm-4.5v', 'nonexistent-model-xyz']) {
    try {
      const r = await zai.chat.completions.create({
        messages: [{ role: 'user', content: 'reply with the single word: ok' }],
        thinking: { type: 'disabled' },
        model: m,
      } as never)
      console.log(`model=${m} → ok, echoed model:`, JSON.stringify(r?.model ?? '(none)'))
    } catch (e) {
      console.log(`model=${m} → error:`, (e as Error).message.slice(0, 120))
    }
  }
}

main().catch((e) => { console.error('fatal:', e.message); process.exit(1) })
