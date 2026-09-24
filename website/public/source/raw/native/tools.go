package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	maxReadBytes   = 60 << 10 // read_file cap: 60KB
	maxListEntries = 300      // list_files cap: 300 entries
	maxBashBytes   = 30 << 10 // bash output cap: 30KB
	defaultBashSec = 60       // bash default timeout: 60s
)

// Env carries the workspace root that all tools are jailed to.
type Env struct {
	Workspace string
}

// NewEnv resolves the workspace root (absolute, symlinks evaluated).
func NewEnv(workspace string) (*Env, error) {
	abs, err := filepath.Abs(workspace)
	if err != nil {
		return nil, err
	}
	root, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, fmt.Errorf("workspace %s: %w", workspace, err)
	}
	return &Env{Workspace: root}, nil
}

// Jail resolves a path inside the workspace and rejects escapes (".." or
// symlink tricks) with a clear error message. The empty path means the
// workspace root itself.
func (e *Env) Jail(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return e.Workspace, nil
	}
	p := filepath.Clean(path)
	if !filepath.IsAbs(p) {
		p = filepath.Join(e.Workspace, p)
	}
	// Resolve as much of the path as exists so symlinked files can't escape.
	if resolved, err := filepath.EvalSymlinks(p); err == nil {
		p = resolved
	} else if dir := filepath.Dir(p); dir != p {
		if rd, rerr := filepath.EvalSymlinks(dir); rerr == nil {
			p = filepath.Join(rd, filepath.Base(p))
		}
	}
	rel, err := filepath.Rel(e.Workspace, p)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path %q escapes the workspace jail (%s)", path, e.Workspace)
	}
	return p, nil
}

// ToolDefs returns the function-calling tool schemas sent to the model.
func ToolDefs() []Tool {
	strProp := func(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }
	intProp := func(desc string) map[string]any { return map[string]any{"type": "integer", "description": desc} }
	mk := func(name, desc string, props map[string]any, required ...string) Tool {
		schema := map[string]any{"type": "object", "properties": props}
		if len(required) > 0 {
			schema["required"] = required
		}
		raw, _ := json.Marshal(schema)
		return Tool{Type: "function", Function: FunctionSpec{Name: name, Description: desc, Parameters: raw}}
	}
	return []Tool{
		mk("read_file",
			"Read a text file inside the workspace. The result starts with a 'path (N bytes)' header line, then the content.",
			map[string]any{
				"path":  strProp("file path, relative to the workspace root"),
				"limit": intProp("optional: read at most this many bytes"),
			}, "path"),
		mk("write_file",
			"Create or overwrite a file inside the workspace with the given content. Parent directories are created automatically.",
			map[string]any{
				"path":    strProp("file path, relative to the workspace root"),
				"content": strProp("full file content to write"),
			}, "path", "content"),
		mk("edit_file",
			"Replace text inside a file: old_string is replaced by new_string (first occurrence only). Errors when old_string is not found.",
			map[string]any{
				"path":       strProp("file path, relative to the workspace root"),
				"old_string": strProp("exact text to find"),
				"new_string": strProp("replacement text"),
			}, "path", "old_string", "new_string"),
		mk("list_files",
			"List files under a directory (default: workspace root), optionally filtered by a glob such as *.txt. Skips .git and node_modules. Max 300 entries.",
			map[string]any{
				"path": strProp("directory to list, relative to the workspace root (default .)"),
				"glob": strProp("optional glob filter, e.g. *.txt"),
			}),
		mk("bash",
			"Run a shell command in the workspace (cmd /c on Windows, sh -c elsewhere) and return the combined stdout+stderr. Default timeout 60s.",
			map[string]any{
				"command":         strProp("shell command to run"),
				"timeout_seconds": intProp("optional: kill the command after this many seconds (default 60)"),
			}, "command"),
	}
}

// ExecuteTool dispatches one model-requested tool call.
func ExecuteTool(env *Env, call ToolCall) (string, error) {
	name := call.Function.Name
	args := map[string]any{}
	if s := strings.TrimSpace(call.Function.Arguments); s != "" {
		if err := json.Unmarshal([]byte(s), &args); err != nil {
			return "", fmt.Errorf("invalid JSON arguments for %s: %w", name, err)
		}
	}
	switch name {
	case "read_file":
		return toolReadFile(env, args)
	case "write_file":
		return toolWriteFile(env, args)
	case "edit_file":
		return toolEditFile(env, args)
	case "list_files":
		return toolListFiles(env, args)
	case "bash":
		return toolBash(env, args)
	default:
		return "", fmt.Errorf("unknown tool %q", name)
	}
}

// toolReadFile reads a file under the jail, capped at 60KB, prefixed with a
// "path (N bytes)" header.
func toolReadFile(env *Env, args map[string]any) (string, error) {
	rel := argString(args, "path")
	if rel == "" {
		return "", fmt.Errorf("read_file: path is required")
	}
	p, err := env.Jail(rel)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(p)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("%s is a directory — use list_files", rel)
	}
	limit := int64(maxReadBytes)
	if l := int64(argInt(args, "limit")); l > 0 && l < limit {
		limit = l
	}
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	buf := make([]byte, limit)
	n, rerr := io.ReadFull(f, buf)
	if rerr != nil && rerr != io.EOF && rerr != io.ErrUnexpectedEOF {
		return "", rerr
	}
	header := fmt.Sprintf("%s (%d bytes", rel, info.Size())
	if int64(n) < info.Size() {
		header += fmt.Sprintf(", first %d shown", n)
	}
	header += ")"
	return header + "\n" + string(buf[:n]), nil
}

// toolWriteFile creates or overwrites a file (with parent dirs) under the jail.
func toolWriteFile(env *Env, args map[string]any) (string, error) {
	rel := argString(args, "path")
	content := argString(args, "content")
	if rel == "" {
		return "", fmt.Errorf("write_file: path is required")
	}
	p, err := env.Jail(rel)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		return "", err
	}
	return fmt.Sprintf("wrote %d bytes to %s", len(content), rel), nil
}

// toolEditFile replaces old_string with new_string (single replace);
// it errors when old_string is not found.
func toolEditFile(env *Env, args map[string]any) (string, error) {
	rel := argString(args, "path")
	oldS := argString(args, "old_string")
	newS := argString(args, "new_string")
	if rel == "" {
		return "", fmt.Errorf("edit_file: path is required")
	}
	if oldS == "" {
		return "", fmt.Errorf("edit_file: old_string is required and must be non-empty")
	}
	p, err := env.Jail(rel)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return "", err
	}
	count := strings.Count(string(data), oldS)
	if count == 0 {
		return "", fmt.Errorf("old_string not found in %s", rel)
	}
	out := strings.Replace(string(data), oldS, newS, 1)
	if err := os.WriteFile(p, []byte(out), 0o644); err != nil {
		return "", err
	}
	if count == 1 {
		return fmt.Sprintf("replaced 1 occurrence in %s", rel), nil
	}
	return fmt.Sprintf("replaced first of %d occurrences in %s — run again for the rest", count, rel), nil
}

// toolListFiles walks a directory (workspace-relative output), skips
// .git/node_modules, applies an optional glob, caps at 300 entries.
func toolListFiles(env *Env, args map[string]any) (string, error) {
	rel := argString(args, "path")
	if rel == "" {
		rel = "."
	}
	glob := argString(args, "glob")
	root, err := env.Jail(rel)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(root)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%s is not a directory", rel)
	}
	var lines []string
	capped := false
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, werr error) error {
		if werr != nil {
			return werr
		}
		if d.IsDir() {
			if p != root && (d.Name() == ".git" || d.Name() == "node_modules") {
				return fs.SkipDir
			}
			return nil
		}
		rp, rerr := filepath.Rel(env.Workspace, p)
		if rerr != nil {
			return nil
		}
		rp = filepath.ToSlash(rp)
		if glob != "" && !globMatch(glob, rp) && !globMatch(glob, d.Name()) {
			return nil
		}
		if len(lines) >= maxListEntries {
			capped = true
			return fs.SkipAll
		}
		lines = append(lines, rp)
		return nil
	})
	if err != nil {
		return "", err
	}
	if len(lines) == 0 {
		return "(no matching files)", nil
	}
	out := strings.Join(lines, "\n")
	if capped {
		out += fmt.Sprintf("\n... (capped at %d entries)", maxListEntries)
	}
	return out, nil
}

// toolBash runs a command via cmd /c (Windows) or sh -c (elsewhere) in the
// workspace, returning combined output. Default timeout 60s, output cap 30KB.
func toolBash(env *Env, args map[string]any) (string, error) {
	command := argString(args, "command")
	if command == "" {
		return "", fmt.Errorf("bash: command is required")
	}
	secs := argInt(args, "timeout_seconds")
	if secs <= 0 {
		secs = defaultBashSec
	}
	shell, flag := "sh", "-c"
	if runtime.GOOS == "windows" {
		shell, flag = "cmd", "/c"
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(secs)*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, shell, flag, command)
	cmd.Dir = env.Workspace
	// CommandContext kills the shell, but orphaned grandchildren can keep
	// the output pipe open; WaitDelay bounds that wait so the tool returns.
	cmd.WaitDelay = time.Second
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	runErr := cmd.Run()

	text := out.String()
	truncated := false
	if len(text) > maxBashBytes {
		text = text[:maxBashBytes]
		truncated = true
	}
	var sb strings.Builder
	sb.WriteString(text)
	if truncated {
		sb.WriteString(fmt.Sprintf("\n[output truncated at %d bytes]", maxBashBytes))
	}
	timedOut := ctx.Err() == context.DeadlineExceeded
	if runErr != nil && !timedOut {
		if ee, ok := runErr.(*exec.ExitError); ok {
			sb.WriteString(fmt.Sprintf("\n[exit status %d]", ee.ExitCode()))
		} else {
			return sb.String(), runErr // e.g. shell not found
		}
	}
	if timedOut {
		sb.WriteString(fmt.Sprintf("\n[command timed out after %ds]", secs))
	}
	return sb.String(), nil
}

// globMatch is filepath.Match with errors treated as "no match".
func globMatch(pattern, name string) bool {
	ok, err := filepath.Match(pattern, name)
	return err == nil && ok
}

// argString extracts a string argument, tolerating numbers/bools from sloppy models.
func argString(args map[string]any, key string) string {
	switch v := args[key].(type) {
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(v)
	case nil:
		return ""
	default:
		return fmt.Sprint(v)
	}
}

// argInt extracts an integer argument, tolerating numeric strings and
// Go-native ints (the JSON path yields float64).
func argInt(args map[string]any, key string) int {
	switch v := args[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case int64:
		return int(v)
	case string:
		n, _ := strconv.Atoi(strings.TrimSpace(v))
		return n
	default:
		return 0
	}
}
