package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// homeDir returns the user home directory: USERPROFILE on Windows, HOME elsewhere.
func homeDir() string {
	if runtime.GOOS == "windows" {
		if p := os.Getenv("USERPROFILE"); p != "" {
			return p
		}
	}
	if p := os.Getenv("HOME"); p != "" {
		return p
	}
	return ""
}

// ConfigPath returns the path of the config file (<home>/.tagent/config.json).
func ConfigPath() (string, error) {
	h := homeDir()
	if h == "" {
		return "", fmt.Errorf("cannot determine home directory (USERPROFILE/HOME not set)")
	}
	return filepath.Join(h, ".tagent", "config.json"), nil
}

func configPathHint() string {
	p, err := ConfigPath()
	if err != nil {
		return "~/.tagent/config.json"
	}
	return p
}

// FallbackEntry is one position in the provider fallback chain.
// A nil Enabled pointer means the entry is enabled.
type FallbackEntry struct {
	Provider string `json:"provider"`
	APIKey   string `json:"apiKey,omitempty"`
	Model    string `json:"model"`
	Enabled  *bool  `json:"enabled,omitempty"`
	Label    string `json:"label,omitempty"`
}

func (f *FallbackEntry) IsEnabled() bool { return f.Enabled == nil || *f.Enabled }

// CustomProvider is a user-defined OpenAI-compatible endpoint.
type CustomProvider struct {
	ID      string   `json:"id"`
	Label   string   `json:"label"`
	BaseURL string   `json:"baseUrl"`
	APIKey  string   `json:"apiKey"`
	Models  []string `json:"models"`
}

// Config is the subset of the TS agent's config that tagent-native reads.
// Parsing is tolerant: missing fields become zero values, unknown fields are ignored.
type Config struct {
	DefaultProvider string            `json:"defaultProvider"`
	DefaultModel    string            `json:"defaultModel"`
	APIKeys         map[string]string `json:"apiKeys"`
	CustomProviders []CustomProvider  `json:"customProviders"`
	Fallback        []FallbackEntry   `json:"fallback"`
}

// LoadConfig reads <home>/.tagent/config.json.
// A missing file is not an error — it yields an empty config
// (setup fails later with a clear "no provider configured" message).
func LoadConfig() (*Config, error) {
	cfg := &Config{}
	path, err := ConfigPath()
	if err != nil {
		return cfg, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if cfg.APIKeys == nil {
		cfg.APIKeys = map[string]string{}
	}
	return cfg, nil
}

// FindCustomProvider looks up a custom provider by id.
func (c *Config) FindCustomProvider(id string) *CustomProvider {
	for i := range c.CustomProviders {
		if c.CustomProviders[i].ID == id {
			return &c.CustomProviders[i]
		}
	}
	return nil
}
