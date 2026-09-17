/**
 * Tagent Core — the agent engine.
 *
 * A provider-agnostic, tool-using agent loop with permissions, checkpoints,
 * memory, skills, subagents, and plugins. Hosted by the CLI daemon
 * (packages/cli) or any other host.
 */

export * from './types'
export { loadConfig, saveConfig, defaultConfig, workspaceDir, GLOBAL_DIR, listRecentWorkspaces, rememberWorkspace, type RecentWorkspace } from './config'
export { PermissionManager } from './permissions'
export { AgentLoop, isReadOnlyTool } from './loop'
export { buildSystemPrompt } from './system-prompt'
export { SessionStore } from './session'
export {
  createCheckpoint, listCheckpoints, undoCheckpoint, shouldCheckpoint,
  type CheckpointMeta,
} from './checkpoints'
export {
  readAgents, saveAgents, listFacts, saveFact, deleteFact, renderMemoryBlock,
  globalAgentsPath, workspaceAgentsPath, memoryTool,
} from './memory'
export {
  listSkills, loadSkill, renderSkillsBlock, loadSkillTool, type SkillDirs,
} from './skills'
export {
  getAdapter, listProviderInfos,
  ZaiAdapter, OpenAICompatibleAdapter, AnthropicAdapter, GoogleAdapter,
  type ProviderAdapter, type CompletionRequest, type CompletionResult,
  type NativeToolDef, type NativeToolCall,
} from './providers'
export { buildToolset, ALL_TOOLS } from './tools'
export {
  startDeviceLogin, pollDeviceToken, validatePat, ensureRepo, pushWorkspace,
} from './github'
export {
  getStorageAdapter, LocalAdapter, MegaAdapter, syncMemoryToMega, pullMemoryFromMega,
  type StorageAdapter,
} from './storage'
export {
  loadPlugins, emitPluginEvent, listPluginFiles, scaffoldPlugin,
  PLUGIN_API_VERSION, type TagentPlugin, type PluginHooks,
} from './plugins'
export * from './util'
export { CURRENT_VERSION, checkUpdate, isNewer, type UpdateInfo } from './version'
