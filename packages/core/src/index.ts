/**
 * Tagent Core — the agent engine.
 *
 * A provider-agnostic, tool-using agent loop with permissions, checkpoints,
 * memory, skills, subagents, and plugins. Hosted by the CLI daemon
 * (packages/cli) or any other host.
 */

export * from './types'
export {
  parseRoleRef,
  resolveSubagentModel,
  resolveMediaModel,
  setRoleRef,
  describeModelRoles,
  type ResolvedRef,
} from './modelroles'
export { loadConfig, saveConfig, defaultConfig, workspaceDir, GLOBAL_DIR, listRecentWorkspaces, rememberWorkspace, updateGlobalConfig, readGlobalConfig, type RecentWorkspace } from './config'
export { PermissionManager } from './permissions'
export { AgentLoop, isReadOnlyTool, extractPlan } from './loop'
export {
  modelContextWindow, guessContextWindow, envContextWindow,
  estimateTokens, estimateMessageTokens,
  renderContextBar, contextPct, fmtTokens,
} from './context'
export {
  compressOutput, slimActionInput, compactSession,
  type CompactOptions, type CompactResult,
} from './compact'
export {
  listSubagents, findSubagent, subagentDirs, renderSubagentsBlock,
  SUBAGENT_TEMPLATE, type SubagentDef,
} from './subagents'
export {
  fallbackTail, fallbackTailFor, fallbackListFor, describeChain, describeChains,
  completeWithFallback, sanitizeFallback,
  type ResolvedChainEntry, type FallbackRole,
} from './fallback'
export { BackgroundSubagents } from './bgsubs'
export {
  diagnosticsCommand, runDiagnostics, renderDiagnosticsBlock,
  DIAGNOSTICS_DEFAULT_TIMEOUT_MS, type DiagnosticsResult,
} from './diagnostics'
export { buildSystemPrompt } from './system-prompt'
export { SessionStore, type TranscriptEntry } from './session'
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
  acceptsImages, withoutImages,
  ZaiAdapter, OpenAICompatibleAdapter, AnthropicAdapter, GoogleAdapter,
  type ProviderAdapter, type CompletionRequest, type CompletionResult,
  type NativeToolDef, type NativeToolCall, type WireMessage,
} from './providers'
export {
  zaiModels, zaiModelsUserPath, EMBEDDED_ZAI_MODELS,
  type ZaiModelEntry, type ZaiModelsFile,
} from './providers/zai-models'
export {
  CATALOG, catalogById, parseModelRef, resolveApiKey,
  refreshModelCache, readModelCache, cleanModelIds,
  modelsFor, modelsForCustom,
  type CatalogEntry, type AdapterKind, type ModelRef, type DiscoveryResult,
} from './providers/registry'
export { buildToolset, ALL_TOOLS, worklogTool, worklogPath, resolveShell } from './tools'
export { askUserTool, parseAskInput, formatAskResponse } from './tools/ask'
export { renderSubsTable } from './tools/subs'
export { exportShare, readShareFile, shareDir, renderShareHtml, type ShareResult } from './share'
export {
  loadRelays, saveRelays, createRelay, findRelayByCode, revokeRelay,
  relayUrl, relaysPath, renderRelayViewerHtml, type RelayEntry,
} from './relay'
export {
  startDeviceLogin, pollDeviceToken, pollDeviceTokenOnce, deviceUrl, validatePat, ensureRepo, ensureRepoDetailed,
  pushWorkspace, defaultRepoName, authUrl, DEFAULT_REMOTE_BASE, deleteRepo,
  getOAuthClientId, BUILTIN_OAUTH_CLIENT_ID,
  type DeviceCodeStart, type DevicePollResult, type EnsureRepoResult, type PushResult, type PushOpts,
} from './github'
export {
  listProjects, getLinkedProject, linkProject, unlinkProject, markSynced,
  refuseLink, isLinkRefused, workspaceHasWork, authStatus, logout,
  syncProject, restoreProject, saveGithubLogin,
  type ProjectReg, type SyncOpts,
} from './projects'
export {
  SyncEngine, manualSync, readSyncSettings, writeSyncSettings, defaultSyncSettings,
  exportVaultPayload, applyVaultPayload, hashPayload, vaultNeedsPassphrase,
  syncDirOf, syncSettingsFile, vaultFileOf,
  deviceIdOf, deviceName, readPresence, writePresence, onlineOthers, PRESENCE_EVERY_MS,
  recordSyncHistory, readSyncHistory,
  SYNC_DIR, MIN_INTERVAL_MS, MAX_INTERVAL_MS, DEFAULT_INTERVAL_MS,
  type RepoSyncSettings, type VaultSettings, type VaultPayload,
  type SyncEvent, type SyncEngineStatus, type SyncEngineOpts,
  type PresenceEntry, type SyncHistoryEntry,
} from './sync'
export {
  encryptVaultJSON, decryptVaultJSON, parseVaultFile,
  getVaultPassphrase, setVaultPassphrase, generatePassphrase, passphraseEquals,
  type VaultFile,
} from './vault'
export {
  listProviderKeys, keychainProviders, activeKeyLabel, addProviderKey,
  removeProviderKey, selectProviderKey, describeProviderKeys, mergeKeychain,
  type ProviderKeyEntry,
} from './keychain'
export {
  CONFIG_REPO_NAME, configRepoDir, configSyncAuth,
  readConfigSyncState, writeConfigSyncState,
  exportConfigPayload, applyConfigPayload, hashConfigPayload,
  pushConfigSync, pullConfigSync, checkConfigRepo, smartConfigSync,
  type ConfigPayload, type ConfigSyncState, type ConfigSyncOpts,
  type ConfigPushResult, type ConfigPullResult, type ConfigRepoHealth,
  type SmartSyncResult,
} from './configsync'
export {
  getStorageAdapter, LocalAdapter, MegaAdapter, syncMemoryToMega, pullMemoryFromMega,
  type StorageAdapter,
} from './storage'
export {
  loadPlugins, emitPluginEvent, listPluginFiles, scaffoldPlugin, pluginMeta,
  pluginToolDefinitions, PLUGIN_API_VERSION,
  type TagentPlugin, type PluginHooks, type PluginTool, type PluginCommand,
} from './plugins'
export {
  McpManager, normalizeMcpServer, MCP_TEMPLATES,
  resolveMcpLauncher, summarizeStderr, mcpFailureHint, diskFreeBytes,
  type McpServerStatus, mcpServersFromConfig,
} from './mcp'
export * from './util'
export { CURRENT_VERSION, checkUpdate, isNewer, type UpdateInfo } from './version'
export {
  fileStateFor, clearCaches, cacheStats, resetCacheStats, bumpStat,
  webCacheGet, webCacheSet, webTtlMs,
  type CacheStats, type FileStamp, type Freshness,
} from './cache'
export {
  getCredential, setCredential, deleteCredential, resolveSecret,
  listCredentialNames, listCredentialsMasked, maskSecret, clearCredentialCache,
} from './credentials'
