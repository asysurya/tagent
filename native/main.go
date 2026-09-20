// tagent-native — the native Tagent for Windows 7+ (including 32-bit).
//
// The full Tagent runs on Bun, which requires Windows 10+ x64. This port is a
// single static Go binary: the same OpenAI-compatible providers, the core
// tool set (read/write/edit/list/bash), an agent loop with function calling,
// the ordered provider-fallback chain — and since v0.11.0 the same app-style
// full-screen TUI as the main CLI (header bar · transcript · boxed editor ·
// ctrl+x menu · slash palette · esc-to-interrupt). Go 1.21 is the last
// toolchain that supports Windows 7/8 — do not upgrade it.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const version = "0.14.0"

/* ---------------------------------- config --------------------------------- */

type FallbackEntry struct {
	Provider string `json:"provider"`
	APIKey   string `json:"apiKey,omitempty"`
	Model    string `json:"model"`
	Enabled  *bool  `json:"enabled,omitempty"`
	Label    string `json:"label,omitempty"`
}

type CustomProvider struct {
	ID      string   `json:"id"`
	Label   string   `json:"label"`
	BaseURL string   `json:"baseUrl"`
	APIKey  string   `json:"apiKey,omitempty"`
	Models  []string `json:"models"`
}

type Config struct {
	DefaultProvider string            `json:"defaultProvider"`
	DefaultModel    string            `json:"defaultModel"`
	APIKeys         map[string]string `json:"apiKeys"`
	CustomProviders []CustomProvider  `json:"customProviders"`
	Fallback        []FallbackEntry   `json:"fallback"`
}

func homeDir() string {
	if h := os.Getenv("USERPROFILE"); h != "" {
		return h
	}
	if h := os.Getenv("HOME"); h != "" {
		return h
	}
	return "."
}

func configPath() string { return filepath.Join(homeDir(), ".tagent", "config.json") }

func loadConfig() Config {
	cfg := Config{
		DefaultProvider: "zai",
		DefaultModel:    "glm-4.7",
		APIKeys:         map[string]string{},
	}
	raw, err := os.ReadFile(configPath())
	if err != nil {
		return cfg
	}
	_ = json.Unmarshal(raw, &cfg) // tolerate unknown fields
	return cfg
}

// saveDefaultProvider rewrites defaultProvider/defaultModel while leaving
// every other config field untouched (the file is shared with the Bun CLI).
func saveDefaultProvider(provider, model string) error {
	path := configPath()
	m := map[string]interface{}{}
	if raw, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(raw, &m) // unknown fields survive as map keys
	}
	m["defaultProvider"] = provider
	m["defaultModel"] = model
	out, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, out, 0o644)
}

/* ------------------------------- provider chain ----------------------------- */

var builtinBase = map[string]string{
	"zai":        "https://api.z.ai/api/paas/v4",
	"openrouter": "https://openrouter.ai/api/v1",
	"groq":       "https://api.groq.com/openai/v1",
	"openai":     "https://api.openai.com/v1",
}

type ChainEntry struct {
	Provider string
	Label    string
	BaseURL  string
	APIKey   string
	Model    string
}

func buildChain(cfg Config) []ChainEntry {
	resolve := func(provider, keyOverride string) (base, key string, ok bool) {
		for _, cp := range cfg.CustomProviders {
			if cp.ID == provider {
				k := keyOverride
				if k == "" {
					k = cp.APIKey
				}
				if k == "" {
					k = cfg.APIKeys[provider]
				}
				return strings.TrimSuffix(cp.BaseURL, "/"), k, true
			}
		}
		if b, found := builtinBase[provider]; found {
			k := keyOverride
			if k == "" {
				k = cfg.APIKeys[provider]
			}
			return b, k, true
		}
		return "", "", false
	}

	var chain []ChainEntry
	if base, key, ok := resolve(cfg.DefaultProvider, ""); ok {
		chain = append(chain, ChainEntry{
			Provider: cfg.DefaultProvider,
			Label:    cfg.DefaultProvider + " (primary)",
			BaseURL:  base,
			APIKey:   key,
			Model:    cfg.DefaultModel,
		})
	}
	for _, f := range cfg.Fallback {
		if f.Enabled != nil && !*f.Enabled || f.Provider == "" || f.Model == "" {
			continue
		}
		if base, key, ok := resolve(f.Provider, f.APIKey); ok {
			label := f.Label
			if label == "" {
				label = f.Provider + "/" + f.Model
			}
			chain = append(chain, ChainEntry{Provider: f.Provider, Label: label, BaseURL: base, APIKey: key, Model: f.Model})
		}
	}
	return chain
}

/* ------------------------------------ llm ----------------------------------- */

type LLMMessage struct {
	Role       string        `json:"role"`
	Content    string        `json:"content"`
	ToolCallID string        `json:"tool_call_id,omitempty"`
	ToolCalls  []LLMToolCall `json:"tool_calls,omitempty"`
}

type LLMToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type llmRequest struct {
	Model    string       `json:"model"`
	Messages []LLMMessage `json:"messages"`
	Tools    []llmToolDef `json:"tools,omitempty"`
}

type llmToolDef struct {
	Type     string      `json:"type"`
	Function llmToolSpec `json:"function"`
}

type llmToolSpec struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

type llmUsage struct {
	PromptTokens     int64 `json:"prompt_tokens"`
	CompletionTokens int64 `json:"completion_tokens"`
}

type llmResponse struct {
	Choices []struct {
		Message struct {
			Role      string        `json:"role"`
			Content   string        `json:"content"`
			ToolCalls []LLMToolCall `json:"tool_calls"`
		} `json:"message"`
	} `json:"choices"`
	Usage llmUsage `json:"usage"`
}

func httpClient() *http.Client {
	tr := &http.Transport{Proxy: http.ProxyFromEnvironment}
	if os.Getenv("TAGENT_TLS_SKIP") == "1" {
		// some networks intercept TLS with untrusted CAs — opt-out escape hatch
		tr.TLSClientConfig.InsecureSkipVerify = true
	}
	return &http.Client{Timeout: 180 * time.Second, Transport: tr}
}

// complete tries every chain entry in order; provider errors fail over.
func complete(ctx context.Context, client *http.Client, chain []ChainEntry, msgs []LLMMessage, tools []llmToolDef, ui TaskUI) (string, []LLMToolCall, llmUsage, error) {
	var usage llmUsage
	var lastErr error
	for _, e := range chain {
		if ctx.Err() != nil {
			return "", nil, usage, ctx.Err()
		}
		body, _ := json.Marshal(llmRequest{Model: e.Model, Messages: msgs, Tools: tools})
		req, err := http.NewRequestWithContext(ctx, "POST", e.BaseURL+"/chat/completions", bytes.NewReader(body))
		if err != nil {
			lastErr = err
			continue
		}
		req.Header.Set("content-type", "application/json")
		if e.APIKey != "" {
			req.Header.Set("authorization", "Bearer "+e.APIKey)
		}
		res, err := client.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return "", nil, usage, ctx.Err()
			}
			ui.ChainFail(e.Label, err.Error())
			lastErr = err
			continue
		}
		raw, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode >= 400 {
			msg := string(raw)
			if len(msg) > 200 {
				msg = msg[:200]
			}
			ui.ChainFail(e.Label, fmt.Sprintf("HTTP %d %s", res.StatusCode, msg))
			lastErr = fmt.Errorf("HTTP %d", res.StatusCode)
			continue
		}
		var parsed llmResponse
		if err := json.Unmarshal(raw, &parsed); err != nil || len(parsed.Choices) == 0 {
			lastErr = fmt.Errorf("bad response from %s", e.Label)
			continue
		}
		return parsed.Choices[0].Message.Content, parsed.Choices[0].Message.ToolCalls, parsed.Usage, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no usable provider — check ~/.tagent/config.json")
	}
	return "", nil, usage, lastErr
}

/* ----------------------------------- tools ---------------------------------- */

const maxFile = 60 * 1024
const maxOut = 30 * 1024

var toolDefs = []llmToolDef{
	{Type: "function", Function: llmToolSpec{
		Name:        "read_file",
		Description: "Read a file inside the workspace (60KB cap).",
		Parameters:  json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"},"limit":{"type":"number"}},"required":["path"]}`)}},
	{Type: "function", Function: llmToolSpec{
		Name:        "write_file",
		Description: "Create or overwrite a file inside the workspace.",
		Parameters:  json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}`)}},
	{Type: "function", Function: llmToolSpec{
		Name:        "edit_file",
		Description: "Replace old_string with new_string in a file (single occurrence).",
		Parameters:  json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"}},"required":["path","old_string","new_string"]}`)}},
	{Type: "function", Function: llmToolSpec{
		Name:        "list_files",
		Description: "List workspace files (max 300, skips .git and node_modules).",
		Parameters:  json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}}}`)}},
	{Type: "function", Function: llmToolSpec{
		Name:        "bash",
		Description: "Run a shell command (cmd /c on Windows, sh -c elsewhere). 60s timeout.",
		Parameters:  json.RawMessage(`{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}`)}},
}

func jail(workspace, p string) (string, error) {
	abs := filepath.Clean(filepath.Join(workspace, p))
	rel, err := filepath.Rel(workspace, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("%q escapes the workspace", p)
	}
	return abs, nil
}

func capBytes(b []byte) []byte {
	if len(b) > maxOut {
		return append(b[:maxOut], []byte("\n…(truncated)")...)
	}
	return b
}

func runTool(name string, args map[string]interface{}, workspace string) string {
	return runToolContext(context.Background(), name, args, workspace)
}

func runToolContext(ctx context.Context, name string, args map[string]interface{}, workspace string) string {
	str := func(k string) string { s, _ := args[k].(string); return s }
	switch name {
	case "read_file":
		abs, err := jail(workspace, str("path"))
		if err != nil {
			return "Error: " + err.Error()
		}
		raw, err := os.ReadFile(abs)
		if err != nil {
			return "Error: " + err.Error()
		}
		if len(raw) > maxFile {
			raw = raw[:maxFile]
		}
		return fmt.Sprintf("===== %s (%d bytes) =====\n%s", str("path"), len(raw), string(raw))
	case "write_file":
		abs, err := jail(workspace, str("path"))
		if err != nil {
			return "Error: " + err.Error()
		}
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return "Error: " + err.Error()
		}
		if err := os.WriteFile(abs, []byte(str("content")), 0o644); err != nil {
			return "Error: " + err.Error()
		}
		return fmt.Sprintf("wrote %s (%d bytes)", str("path"), len(str("content")))
	case "edit_file":
		abs, err := jail(workspace, str("path"))
		if err != nil {
			return "Error: " + err.Error()
		}
		raw, err := os.ReadFile(abs)
		if err != nil {
			return "Error: " + err.Error()
		}
		oldS, newS := str("old_string"), str("new_string")
		if !strings.Contains(string(raw), oldS) {
			return "Error: old_string not found in " + str("path")
		}
		out := strings.Replace(string(raw), oldS, newS, 1)
		if err := os.WriteFile(abs, []byte(out), 0o644); err != nil {
			return "Error: " + err.Error()
		}
		return fmt.Sprintf("edited %s", str("path"))
	case "list_files":
		base := str("path")
		abs, err := jail(workspace, base)
		if err != nil {
			return "Error: " + err.Error()
		}
		var files []string
		filepath.WalkDir(abs, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if d.Name() == ".git" || d.Name() == "node_modules" {
					return filepath.SkipDir
				}
				return nil
			}
			if len(files) < 300 {
				if rel, e := filepath.Rel(workspace, p); e == nil {
					files = append(files, rel)
				}
			}
			return nil
		})
		if len(files) == 0 {
			return "(no files)"
		}
		return strings.Join(files, "\n")
	case "bash":
		var cmd *exec.Cmd
		if runtime.GOOS == "windows" {
			cmd = exec.CommandContext(ctx, "cmd", "/c", str("command"))
		} else {
			cmd = exec.CommandContext(ctx, "sh", "-c", str("command"))
		}
		cmd.Dir = workspace
		done := make(chan []byte, 1)
		go func() {
			out, _ := cmd.CombinedOutput()
			done <- capBytes(out)
		}()
		select {
		case out := <-done:
			return string(out)
		case <-ctx.Done():
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			return "Error: interrupted"
		case <-time.After(60 * time.Second):
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			return "Error: command timed out (60s)"
		}
	}
	return "Error: unknown tool " + name
}

/* ------------------------------------ loop ---------------------------------- */

const systemPrompt = "You are tagent-native, a native coding agent (Windows 7+ compatible build of Tagent). " +
	"Work inside the workspace. Use the tools to do the task. Be direct and terse. " +
	"When the task is done, reply with a short summary and no tool calls."

// runTask runs one agent task, reporting progress through ui and appending
// the conversation (system + trimmed history) through conv.
func runTask(ctx context.Context, client *http.Client, chain []ChainEntry, workspace, task string, maxTurns int, ui TaskUI, conv *[]LLMMessage) {
	msgs := append([]LLMMessage(nil), *conv...)
	msgs = append(msgs, LLMMessage{Role: "user", Content: task})
	for len(msgs) > 21 { // keep system + the last 20 turns
		msgs = append([]LLMMessage{msgs[0]}, msgs[len(msgs)-20:]...)
	}
	finish := func() { *conv = msgs }
	defer finish()

	for turn := 0; turn < maxTurns; turn++ {
		if ctx.Err() != nil {
			ui.Fail("interrupted")
			return
		}
		ui.Status("thinking")
		content, calls, usage, err := complete(ctx, client, chain, msgs, toolDefs, ui)
		if usage.PromptTokens > 0 || usage.CompletionTokens > 0 {
			ui.Tokens(usage.PromptTokens, usage.CompletionTokens)
		}
		if err != nil {
			if ctx.Err() != nil {
				ui.Fail("interrupted")
			} else {
				ui.Fail(err.Error())
			}
			return
		}
		if len(calls) == 0 {
			ui.Assistant(content)
			msgs = append(msgs, LLMMessage{Role: "assistant", Content: content})
			return
		}
		assistant := LLMMessage{Role: "assistant", Content: content}
		for _, c := range calls {
			assistant.ToolCalls = append(assistant.ToolCalls, c)
		}
		msgs = append(msgs, assistant)
		for _, c := range calls {
			if ctx.Err() != nil {
				ui.Fail("interrupted")
				return
			}
			ui.ToolCall(c.Function.Name, truncate(c.Function.Arguments, 80))
			var args map[string]interface{}
			_ = json.Unmarshal([]byte(c.Function.Arguments), &args)
			if args == nil {
				args = map[string]interface{}{}
			}
			out := runToolContext(ctx, c.Function.Name, args, workspace)
			ui.ToolResult(out)
			msgs = append(msgs, LLMMessage{Role: "tool", ToolCallID: c.ID, Content: truncate(out, maxOut)})
		}
	}
	if ctx.Err() != nil {
		ui.Fail("interrupted")
		return
	}
	ui.Fail("(max turns reached)")
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

/* -------------------------------- line-mode ui ------------------------------ */

// lineUI reports through plain stdout/stderr — used by `run` and the
// non-TTY fallback REPL.
type lineUI struct{}

func (lineUI) Status(string)              {}
func (lineUI) Tokens(int64, int64)        {}
func (lineUI) ToolCall(name, args string) { fmt.Printf("  > %s %s\n", name, args) }
func (lineUI) ToolResult(out string) {
	fmt.Printf("    %s\n", strings.SplitN(out, "\n", 2)[0])
}
func (lineUI) Assistant(text string) { fmt.Println(text) }
func (lineUI) Fail(msg string)       { fmt.Fprintln(os.Stderr, "error: "+msg) }
func (lineUI) ChainFail(label, reason string) {
	fmt.Fprintf(os.Stderr, "  ! provider %s failed (%s) — trying next\n", label, reason)
}

func classicREPL(cfg Config, chain []ChainEntry, workspace string, maxTurns int) {
	client := httpClient()
	conv := []LLMMessage{{Role: "system", Content: systemPrompt}}
	fmt.Printf("tagent-native %s (line mode) — workspace: %s\n", version, workspace)
	if len(chain) == 0 {
		fmt.Println("no usable provider — configure ~/.tagent/config.json (see README)")
	}
	fmt.Println("type a task per line · Ctrl+C to exit")
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	for sc.Scan() {
		task := strings.TrimSpace(sc.Text())
		if task == "" {
			continue
		}
		runTask(context.Background(), client, chain, workspace, task, maxTurns, lineUI{}, &conv)
	}
}

/* ----------------------------------- main ----------------------------------- */

func selftest(workspace string) int {
	fail := 0
	check := func(name string, cond bool) {
		if cond {
			fmt.Printf("PASS %s\n", name)
		} else {
			fmt.Printf("FAIL %s\n", name)
			fail++
		}
	}
	run := func(tool string, args map[string]interface{}) string {
		return runTool(tool, args, workspace)
	}
	// write into a dedicated subdir so the list_files check is deterministic
	// even in huge workspaces (the walk caps at 300 files)
	run("write_file", map[string]interface{}{"path": "selftest-dir/selftest.txt", "content": "hello native"})
	check("write_file", strings.Contains(run("read_file", map[string]interface{}{"path": "selftest-dir/selftest.txt"}), "hello native"))
	run("edit_file", map[string]interface{}{"path": "selftest-dir/selftest.txt", "old_string": "hello", "new_string": "hi"})
	check("edit_file", strings.Contains(run("read_file", map[string]interface{}{"path": "selftest-dir/selftest.txt"}), "hi native"))
	check("list_files", strings.Contains(run("list_files", map[string]interface{}{"path": "selftest-dir"}), "selftest.txt"))
	check("bash", strings.Contains(strings.ToLower(run("bash", map[string]interface{}{"command": "echo hello"})), "hello"))
	check("jail rejects escape", strings.HasPrefix(run("read_file", map[string]interface{}{"path": "../escaped.txt"}), "Error:"))
	_ = os.RemoveAll(filepath.Join(workspace, "selftest-dir"))
	if fail > 0 {
		fmt.Printf("%d FAILED\n", fail)
		return 1
	}
	fmt.Println("ALL PASS")
	return 0
}

func diagLines(workspace string) []string {
	cfg := loadConfig()
	chain := buildChain(cfg)
	lines := []string{
		fmt.Sprintf("version    : tagent-native %s (%s/%s · %s)", version, runtime.GOOS, runtime.GOARCH, runtime.Version()),
		fmt.Sprintf("workspace  : %s", workspace),
		fmt.Sprintf("config     : %s", configPath()),
	}
	if _, err := os.Stat(configPath()); err != nil {
		lines = append(lines, "             (missing — see README)")
	}
	for _, p := range []string{"zai", "openrouter", "groq", "openai"} {
		state := "MISSING"
		if _, ok := cfg.APIKeys[p]; ok {
			state = "key set"
		}
		lines = append(lines, fmt.Sprintf("  %-10s: %s", p, state))
	}
	for _, cp := range cfg.CustomProviders {
		lines = append(lines, fmt.Sprintf("  %-10s: custom · %d model(s) · %s", cp.ID, len(cp.Models), cp.BaseURL))
	}
	lines = append(lines, fmt.Sprintf("chain      : %d entries", len(chain)))
	for i, e := range chain {
		lines = append(lines, fmt.Sprintf("  %d. %s · %s", i+1, e.Label, e.Model))
	}
	lines = append(lines, fmt.Sprintf("tls        : TAGENT_TLS_SKIP=%s", os.Getenv("TAGENT_TLS_SKIP")))
	return lines
}

func main() {
	workspace := flag.String("workspace", ".", "workspace root")
	maxTurns := flag.Int("max-turns", 30, "agent turn budget")
	flag.Parse()
	args := flag.Args()

	absWorkspace, err := filepath.Abs(*workspace)
	if err != nil {
		absWorkspace = "."
	}

	switch {
	case len(args) > 0 && args[0] == "version":
		fmt.Printf("tagent-native %s (%s/%s, go runtime %s)\n", version, runtime.GOOS, runtime.GOARCH, runtime.Version())
		return
	case len(args) > 0 && args[0] == "selftest":
		os.Exit(selftest(absWorkspace))
	case len(args) > 0 && args[0] == "diag":
		for _, l := range diagLines(absWorkspace) {
			fmt.Println(l)
		}
		return
	case len(args) > 0 && args[0] == "run" && len(args) > 1:
		cfg := loadConfig()
		chain := buildChain(cfg)
		conv := []LLMMessage{{Role: "system", Content: systemPrompt}}
		runTask(context.Background(), httpClient(), chain, absWorkspace, strings.Join(args[1:], " "), *maxTurns, lineUI{}, &conv)
		return
	}

	// interactive — take over the terminal when we can, else line mode
	cfg := loadConfig()
	chain := buildChain(cfg)
	if stdoutIsTTY() {
		if term, err := openTerminal(); err == nil {
			app := newApp(term, cfg, chain, absWorkspace, version, *maxTurns)
			if err := app.run(); err != nil {
				fmt.Fprintf(os.Stderr, "tui error: %v\n", err)
			}
			return
		}
	}
	classicREPL(cfg, chain, absWorkspace, *maxTurns)
}

var _ = errors.New // keep errors imported for context checks in future patches
