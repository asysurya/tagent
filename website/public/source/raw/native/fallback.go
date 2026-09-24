package main

import (
	"fmt"
	"os"
)

// ChainEntry is one provider/model/key position in the fallback chain.
type ChainEntry struct {
	Provider string // provider id (builtin or customProviders id)
	Label    string // human-readable label used in messages
	BaseURL  string
	APIKey   string
	Model    string
}

// Describe returns "provider/model" for usage lines and errors.
func (e ChainEntry) Describe() string { return e.Provider + "/" + e.Model }

// BuildChain assembles the provider chain: entry 0 is the primary
// (defaultProvider/defaultModel, or the --provider/--model overrides),
// followed by every enabled fallback entry in order.
//
// A non-empty apiKey on a fallback entry OVERRIDES the stored key for that
// position — that is how the same provider gets stacked multiple times with
// different keys (same provider id, different apiKey per entry).
func BuildChain(cfg *Config, providerOverride, modelOverride string) ([]ChainEntry, error) {
	provider := providerOverride
	if provider == "" {
		provider = cfg.DefaultProvider
	}
	if provider == "" {
		return nil, fmt.Errorf("no provider configured — set defaultProvider in %s or pass --provider", configPathHint())
	}
	model := modelOverride
	if model == "" {
		model = cfg.DefaultModel
	}
	if model == "" {
		return nil, fmt.Errorf("no model configured — set defaultModel in %s or pass --model", configPathHint())
	}

	chain := make([]ChainEntry, 0, 1+len(cfg.Fallback))
	primary, err := resolveEntry(cfg, provider, model, "")
	if err != nil {
		return nil, err
	}
	chain = append(chain, primary)

	for i := range cfg.Fallback {
		fe := &cfg.Fallback[i]
		if !fe.IsEnabled() {
			continue
		}
		entry, err := resolveEntry(cfg, fe.Provider, fe.Model, fe.APIKey)
		if err != nil {
			// One broken fallback entry must not kill the whole chain.
			fmt.Fprintf(os.Stderr, "warning: skipping fallback %s/%s: %v\n", fe.Provider, fe.Model, err)
			continue
		}
		if fe.Label != "" {
			entry.Label = fe.Label
		}
		chain = append(chain, entry)
	}
	return chain, nil
}

// resolveEntry maps a provider id to baseUrl + key; apiKeyOverride (if
// non-empty) replaces the key that would otherwise come from apiKeys /
// customProviders. baseUrl and key always come from the same entry, so
// custom providers with a per-entry key stay consistent.
func resolveEntry(cfg *Config, provider, model, apiKeyOverride string) (ChainEntry, error) {
	entry := ChainEntry{Provider: provider, Model: model, Label: provider}
	if model == "" {
		return entry, fmt.Errorf("provider %q has no model set", provider)
	}
	if cp := cfg.FindCustomProvider(provider); cp != nil {
		entry.BaseURL = cp.BaseURL
		entry.APIKey = cp.APIKey
		if cp.Label != "" {
			entry.Label = cp.Label
		}
	} else {
		base, ok := builtinProviders[provider]
		if !ok {
			return entry, fmt.Errorf("unknown provider %q (builtin: zai, openrouter, groq, openai — anything else needs a customProviders entry with id %q)", provider, provider)
		}
		entry.BaseURL = base
		entry.APIKey = cfg.APIKeys[provider]
	}
	if apiKeyOverride != "" {
		entry.APIKey = apiKeyOverride
	}
	return entry, nil
}

// ExecuteWithFallback tries each chain entry in order. Transport errors,
// HTTP >= 500 and 429 move on to the next entry; a 4xx (except 429) also
// moves on but prints the response body, which usually names the exact
// problem (bad key, bad model, out of credit). When all entries fail it
// returns the last error.
func ExecuteWithFallback(client *Client, chain []ChainEntry, messages []Message, tools []Tool) (*ChatResponse, string, error) {
	if len(chain) == 0 {
		return nil, "", fmt.Errorf("empty provider chain")
	}
	var lastErr error
	for i, entry := range chain {
		resp, err := client.ChatCompletions(entry.BaseURL, entry.APIKey, entry.Model, messages, tools)
		if err == nil {
			return resp, entry.Describe(), nil
		}
		lastErr = fmt.Errorf("%s: %w", entry.Describe(), err)
		if i+1 >= len(chain) {
			break
		}
		next := chain[i+1].Label
		if apiErr, ok := err.(*APIError); ok && apiErr.Status >= 400 && apiErr.Status < 500 && apiErr.Status != 429 {
			fmt.Fprintf(os.Stderr, "provider %s failed (%v) — falling back to %s\n  response: %s\n",
				entry.Label, err, next, truncate(apiErr.Body, 400))
		} else {
			fmt.Fprintf(os.Stderr, "provider %s failed (%v) — falling back to %s\n", entry.Label, err, next)
		}
	}
	return nil, "", fmt.Errorf("all providers in the chain failed — last error: %w", lastErr)
}
