// Oracle for frozen CLIProxyAPI c404af96. Run inside its module, never its server.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor/helps"
	_ "github.com/router-for-me/CLIProxyAPI/v7/internal/thinking/provider/claude"
	chat "github.com/router-for-me/CLIProxyAPI/v7/internal/translator/claude/openai/chat-completions"
	sdk "github.com/router-for-me/CLIProxyAPI/v7/sdk/translator"
)

type Case struct {
	ID        string            `json:"id"`
	Model     string            `json:"model"`
	Input     json.RawMessage   `json:"input,omitempty"`
	InputRaw  string            `json:"inputRawJSON,omitempty"`
	Events    []json.RawMessage `json:"events,omitempty"`
	Exception string            `json:"exception,omitempty"`
}

func main() {
	raw, err := os.ReadFile(os.Args[1])
	must(err)
	var cases []Case
	must(json.Unmarshal(raw, &cases))
	results := []map[string]any{}
	for _, c := range cases {
		if c.InputRaw != "" {
			c.Input = []byte(c.InputRaw)
		}
		r := map[string]any{"id": c.ID, "model": c.Model, "capability": registry.LookupModelInfo(c.Model, "claude")}
		if len(c.Input) > 0 {
			direct := chat.ConvertOpenAIRequestToClaude(c.Model, c.Input, true)
			translated := sdk.TranslateRequest(sdk.FormatOpenAI, sdk.FormatClaude, c.Model, c.Input, true)
			applied, err := helps.ApplyThinkingWithSourcePayload(translated, c.Input, c.Input, c.Model, "openai", "claude", "claude")
			r["request"] = json.RawMessage(direct)
			r["sdk"] = json.RawMessage(translated)
			if err != nil {
				r["thinkingError"] = err.Error()
			} else {
				r["thinking"] = json.RawMessage(applied)
			}
		}
		if len(c.Events) > 0 {
			var state any
			chunks := []json.RawMessage{}
			lines := []string{}
			for _, event := range c.Events {
				var compact bytes.Buffer
				must(json.Compact(&compact, event))
				line := "data: " + compact.String()
				lines = append(lines, line)
				for _, chunk := range sdk.TranslateStream(context.Background(), sdk.FormatClaude, sdk.FormatOpenAI, c.Model, []byte(`{}`), []byte(`{}`), []byte(line), &state) {
					chunks = append(chunks, json.RawMessage(chunk))
				}
			}
			var ignored any
			r["chunks"] = chunks
			r["buffered"] = json.RawMessage(sdk.TranslateNonStream(context.Background(), sdk.FormatClaude, sdk.FormatOpenAI, c.Model, []byte(`{}`), []byte(`{}`), []byte(strings.Join(lines, "\n")), &ignored))
		}
		if c.Exception != "" {
			r["exception"] = c.Exception
		}
		results = append(results, r)
	}
	out := map[string]any{"reference": "c404af96ebacedf8168b3c2bdbf4449a21cd1c1e", "capabilities": registry.GetClaudeModels(), "stages": []string{"direct registered request converter", "SDK request + summary", "helps.ApplyThinkingWithSourcePayload + registered Claude applier", "SDK registered stream and buffered responses"}, "cases": results}
	b, err := json.MarshalIndent(out, "", "  ")
	must(err)
	fmt.Println(string(b))
}
func must(err error) {
	if err != nil {
		panic(err)
	}
}
