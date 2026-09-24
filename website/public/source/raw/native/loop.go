package main

import (
	"fmt"
	"os"
	"strings"
)

const systemPrompt = "You are tagent-native, a minimal native coding agent (Windows 7+ compatible build of Tagent). Work inside the workspace. Use the tools to do the task. Be direct and terse. When the task is done, reply with a short summary and no tool calls."

// Loop holds one conversation (system prompt + messages) and runs agent
// tasks inside it. The REPL reuses the same Loop, so every task shares
// one conversation.
type Loop struct {
	Client    *Client
	Chain     []ChainEntry
	Env       *Env
	Tools     []Tool
	MaxTurns  int
	Messages  []Message
	InTokens  int
	OutTokens int
}

// NewLoop builds a loop with the system prompt as message 0.
func NewLoop(client *Client, chain []ChainEntry, env *Env, maxTurns int) *Loop {
	return &Loop{
		Client:   client,
		Chain:    chain,
		Env:      env,
		Tools:    ToolDefs(),
		MaxTurns: maxTurns,
		Messages: []Message{{Role: "system", Content: systemPrompt}},
	}
}

// Run executes one agent task: append the user message, then turn the
// loop until the model replies with plain text (or --max-turns is hit).
// On tool calls it prints a "⚙ tool" line per call, executes the tools and
// appends the tool-result messages (role "tool", tool_call_id).
func (l *Loop) Run(task string) error {
	l.Messages = append(l.Messages, Message{Role: "user", Content: task})
	for turn := 1; turn <= l.MaxTurns; turn++ {
		resp, via, err := ExecuteWithFallback(l.Client, l.Chain, l.Messages, l.Tools)
		if err != nil {
			return err
		}
		if len(resp.Choices) == 0 {
			return fmt.Errorf("%s returned no choices", via)
		}
		msg := resp.Choices[0].Message
		l.InTokens += resp.Usage.PromptTokens
		l.OutTokens += resp.Usage.CompletionTokens

		if len(msg.ToolCalls) == 0 {
			if s := strings.TrimSpace(msg.Content); s != "" {
				fmt.Println(msg.Content)
			}
			l.Messages = append(l.Messages, msg)
			if l.InTokens > 0 || l.OutTokens > 0 {
				fmt.Fprintf(os.Stderr, "· %d in / %d out tokens via %s\n", l.InTokens, l.OutTokens, via)
			}
			return nil
		}

		// Normalize (some providers omit type) and record the assistant message.
		for i := range msg.ToolCalls {
			if msg.ToolCalls[i].Type == "" {
				msg.ToolCalls[i].Type = "function"
			}
		}
		l.Messages = append(l.Messages, msg)

		for _, tc := range msg.ToolCalls {
			preview := truncate(singleLine(tc.Function.Arguments), 100)
			if preview != "" {
				fmt.Printf("⚙ %s %s\n", tc.Function.Name, preview)
			} else {
				fmt.Printf("⚙ %s\n", tc.Function.Name)
			}
			result, err := ExecuteTool(l.Env, tc)
			if err != nil {
				result = "error: " + err.Error()
			}
			l.Messages = append(l.Messages, Message{
				Role:       "tool",
				ToolCallID: tc.ID,
				Name:       tc.Function.Name,
				Content:    result,
			})
		}
	}
	return fmt.Errorf("max turns (%d) reached before the task finished", l.MaxTurns)
}

// singleLine flattens newlines so tool previews stay on one line.
func singleLine(s string) string {
	return strings.ReplaceAll(strings.TrimSpace(s), "\n", " ")
}
