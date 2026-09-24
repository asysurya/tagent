package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// builtinProviders maps builtin provider ids to their OpenAI-compatible
// base URLs. Anthropic's direct API is intentionally absent (it is not
// OpenAI-compatible); users can add anything else via customProviders
// with their own baseUrl.
var builtinProviders = map[string]string{
	"zai":        "https://api.z.ai/api/paas/v4",
	"openrouter": "https://openrouter.ai/api/v1",
	"groq":       "https://api.groq.com/openai/v1",
	"openai":     "https://api.openai.com/v1",
}

// Message is one chat message (system / user / assistant / tool).
type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	Name       string     `json:"name,omitempty"`
}

// ToolCall is a function call requested by the model.
type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type,omitempty"` // "function"
	Function FunctionCall `json:"function"`
}

// FunctionCall carries the function name and its raw JSON arguments string.
type FunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// Tool is an OpenAI-style function tool definition.
type Tool struct {
	Type     string       `json:"type"` // "function"
	Function FunctionSpec `json:"function"`
}

// FunctionSpec is the function half of a tool definition.
type FunctionSpec struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

// ChatRequest is the (non-streaming) chat-completions request body.
type ChatRequest struct {
	Model      string    `json:"model"`
	Messages   []Message `json:"messages"`
	Tools      []Tool    `json:"tools,omitempty"`
	ToolChoice string    `json:"tool_choice,omitempty"`
}

// Usage is the token usage block of a response.
type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// ChatResponse is the (non-streaming) chat-completions response.
type ChatResponse struct {
	ID      string `json:"id"`
	Model   string `json:"model"`
	Choices []struct {
		Index        int     `json:"index"`
		Message      Message `json:"message"`
		FinishReason string  `json:"finish_reason"`
	} `json:"choices"`
	Usage Usage `json:"usage"`
}

// APIError is a non-2xx reply from a provider.
type APIError struct {
	Status int
	Body   string
	URL    string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("HTTP %d from %s: %s", e.Status, e.URL, truncate(e.Body, 300))
}

// Client speaks the OpenAI-compatible chat-completions protocol.
type Client struct {
	HTTP *http.Client
}

// NewHTTPClient builds the shared HTTP client (180s timeout).
// TAGENT_TLS_SKIP=1 installs a transport that skips TLS certificate
// verification — an escape hatch for networks with broken TLS interception
// where every certificate looks self-signed.
func NewHTTPClient() *Client {
	tr := &http.Transport{
		Proxy:           http.ProxyFromEnvironment,
		MaxIdleConns:    10,
		IdleConnTimeout: 90 * time.Second,
	}
	if os.Getenv("TAGENT_TLS_SKIP") == "1" {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // explicit opt-in
	}
	return &Client{HTTP: &http.Client{Timeout: 180 * time.Second, Transport: tr}}
}

// ChatCompletions POSTs {baseUrl}/chat/completions with a Bearer key
// and returns choices[0].message (role, content, tool_calls) plus usage.
func (c *Client) ChatCompletions(baseUrl, apiKey, model string, messages []Message, tools []Tool) (*ChatResponse, error) {
	url := strings.TrimSuffix(baseUrl, "/") + "/chat/completions"
	reqBody := ChatRequest{Model: model, Messages: messages}
	if len(tools) > 0 {
		reqBody.Tools = tools
		reqBody.ToolChoice = "auto"
	}
	data, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "tagent-native/"+version)
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("transport: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, &APIError{Status: resp.StatusCode, Body: string(body), URL: url}
	}
	var out ChatResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("decode response from %s: %w (body: %s)", url, err, truncate(string(body), 300))
	}
	return &out, nil
}

// truncate cuts s to at most max runes, appending an ellipsis.
func truncate(s string, max int) string {
	if max <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}
