package main

// tui.go — the full-screen app (the same opencode-style layout as the Bun
// CLI's tui-app.ts, tuned for the native build):
//
//   ┌ header bar: workspace · NATIVE chip · model/chain · spinner/tokens ┐
//   │ transcript (wrapped, scrollable, "N new lines" indicator)         │
//   │ overlay / slash palette (drawn above the editor)                  │
//   │ status row: spinner · running tool · notices                      │
//   │ boxed editor with reverse-video cursor                            │
//   └ shortcut footer                                                   ┘
//
// Win7-safe glyphs (square box corners, ASCII spinner) are selected via
// runtime.GOOS. The agent loop runs in a goroutine and reports through the
// TaskUI interface; Esc interrupts via context cancellation.

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

/* --------------------------------- glyphs --------------------------------- */

func glyph(unix, win string) string {
	if runtime.GOOS == "windows" {
		return win
	}
	return unix
}

var (
	SPINNER     = []rune(glyph("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏", "|/-\\"))
	boxTL       = glyph("╭", "┌")
	boxTR       = glyph("╮", "┐")
	boxBL       = glyph("╰", "└")
	boxBR       = glyph("╯", "┘")
	boxHZ       = "─"
	boxVT       = glyph("│", "│")
	cursorCh    = glyph("❯ ", "> ")
	arrowsLbl   = glyph("↑↓", "up/dn")
	failCh      = glyph("✗ ", "x ")
	toolArrow   = glyph("→ ", "> ")
	editorHint  = "Message tagent... ( / commands · ctrl+x menu )"
	footerFull  = "enter send · alt+enter newline · ctrl+x menu · pgup/pgdn scroll · esc interrupt/clear · ctrl+c exit"
	footerShort = "enter send · ctrl+x menu · esc interrupt · ctrl+c exit"
)

const noticeTTL = 2500 * time.Millisecond

type slashCmd struct{ name, desc string }

var slashCmds = []slashCmd{
	{"model", "switch the active provider & model"},
	{"chain", "show the ordered fallback chain"},
	{"diag", "diagnostics — config · keys · workspace"},
	{"clear", "clear the transcript & conversation"},
	{"help", "keys and commands"},
	{"exit", "quit tagent-native"},
}

/* --------------------------------- overlays -------------------------------- */

type overlay struct {
	title  string
	items  []string
	descs  []string
	cur    int
	text   []Row
	onPick func(a *App, i int)
}

type palInfo struct {
	token string
	items []slashCmd
}

/* ----------------------------------- app ---------------------------------- */

type App struct {
	mu   sync.Mutex
	term Terminal
	w, h int

	version  string
	wsName   string
	wsPath   string
	cfg      Config
	chain    []ChainEntry
	client   *http.Client
	maxTurns int
	conv     []LLMMessage

	log      []Row
	flat     []Row
	flatW    int
	offset   int
	newBelow int

	edLines  []string
	edRow    int
	edCol    int
	edScroll int
	hist     []string
	histIdx  int

	running   bool
	cancel    context.CancelFunc
	status    string
	notice    string
	noticeAt  time.Time
	spin      int
	tokensIn  int64
	tokensOut int64
	lastDone  string

	overlay *overlay
	palCur  int
	palOff  string
	quit    bool
	dirty   bool
}

// TaskUI is how the agent loop reports progress without touching the screen.
type TaskUI interface {
	Status(label string)
	ToolCall(name, args string)
	ToolResult(out string)
	Assistant(text string)
	Fail(msg string)
	ChainFail(label, reason string)
	Tokens(in, out int64)
}

func newApp(term Terminal, cfg Config, chain []ChainEntry, workspace, version string, maxTurns int) *App {
	name := workspace
	if b := filepath.Base(workspace); b != "" && b != "/" && b != "." {
		name = b
	}
	a := &App{
		term:     term,
		version:  version,
		wsName:   name,
		wsPath:   workspace,
		cfg:      cfg,
		chain:    chain,
		client:   httpClient(),
		maxTurns: maxTurns,
		edLines:  []string{""},
		conv:     []LLMMessage{{Role: "system", Content: systemPrompt}},
	}
	a.greet()
	return a
}

func (a *App) greet() {
	a.println(
		Row{S("tagent-native "+a.version, SBold), S(" — the full-screen agent for older machines", SDim)},
		Row{S("workspace ", SDim), S(a.wsPath, 0)},
	)
	if len(a.chain) > 0 {
		keyNote := ""
		if a.chain[0].APIKey == "" {
			keyNote = "  ·  no api key — set it in ~/.tagent/config.json"
		}
		a.println(Row{S("provider ", SDim), S(a.chain[0].Label+" · "+a.chain[0].Model, SCyan),
			S("  ·  /help keys · ctrl+x menu"+keyNote, SDim)})
	} else {
		a.println(Row{S("no provider configured — set apiKey in ~/.tagent/config.json (see README)", SRed)})
	}
	a.println(Row{})
}

/* ------------------------------ thread-safe ops ---------------------------- */

func (a *App) println(rows ...Row) {
	a.mu.Lock()
	a.log = append(a.log, rows...)
	a.flat = nil
	if a.offset > 0 {
		a.newBelow += len(rows)
	}
	a.mu.Unlock()
}

func (a *App) setNotice(msg string) {
	a.mu.Lock()
	a.notice = msg
	a.noticeAt = time.Now()
	a.mu.Unlock()
}

func (a *App) isRunning() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.running
}

// Status implements TaskUI.
func (a *App) Status(label string) {
	a.mu.Lock()
	a.status = label
	a.mu.Unlock()
}

// ToolCall implements TaskUI.
func (a *App) ToolCall(name, args string) {
	a.println(Row{S(toolArrow, SCyan), S(name, SCyan), S(" "+truncVis(args, 100), SDim)})
}

// ToolResult implements TaskUI.
func (a *App) ToolResult(out string) {
	first := strings.SplitN(out, "\n", 2)[0]
	a.println(Row{S("  "+truncVis(first, 140), SDim)})
}

// Assistant implements TaskUI.
func (a *App) Assistant(text string) {
	for _, l := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
		a.println(Row{S(l, 0)})
	}
}

// Fail implements TaskUI.
func (a *App) Fail(msg string) {
	a.println(Row{S(failCh+msg, SRed)})
}

// ChainFail implements TaskUI.
func (a *App) ChainFail(label, reason string) {
	a.println(Row{S("! provider "+label+" failed — trying next", SYellow)})
}

// Tokens implements TaskUI.
func (a *App) Tokens(in, out int64) {
	a.mu.Lock()
	a.tokensIn += in
	a.tokensOut += out
	a.mu.Unlock()
}

/* --------------------------------- the loop -------------------------------- */

func (a *App) run() error {
	if err := a.term.Open(); err != nil {
		return err
	}
	defer a.term.Close()
	a.w, a.h = a.term.Size()
	a.render()
	tick := 0
	for !a.quit {
		if ev, ok := a.term.PollEvent(50); ok {
			a.handle(ev)
		}
		w, h := a.term.Size()
		if w != a.w || h != a.h {
			a.mu.Lock()
			a.w, a.h = w, h
			a.flat = nil
			a.mu.Unlock()
			a.dirty = true
		}
		tick++
		if a.isRunning() && tick%2 == 0 {
			a.mu.Lock()
			a.spin = (a.spin + 1) % len(SPINNER)
			a.mu.Unlock()
			a.dirty = true
		}
		if a.needPaint() {
			a.render()
		}
	}
	return nil
}

func (a *App) needPaint() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.dirty || a.running || a.notice != "" {
		a.dirty = false
		return true
	}
	return false
}

func (a *App) render() {
	a.mu.Lock()
	rows := a.buildFrame()
	a.mu.Unlock()
	a.term.Draw(rows)
}

/* --------------------------------- events ---------------------------------- */

func (a *App) handle(ev Event) {
	a.dirty = true
	if ev.Key == KeyCtrlC {
		a.quit = true
		return
	}
	if a.overlay != nil {
		a.handleOverlayKey(ev)
		return
	}
	if pal := a.palette(); pal != nil {
		switch ev.Key {
		case KeyUp:
			if a.palCur > 0 {
				a.palCur--
			}
			return
		case KeyDown:
			if a.palCur < len(pal.items)-1 {
				a.palCur++
			}
			return
		case KeyTab:
			a.paletteComplete(false)
			return
		case KeyEnter:
			a.paletteComplete(true)
			return
		case KeyEsc:
			a.palOff = pal.token
			return
		}
	}
	switch ev.Key {
	case KeyPgUp:
		a.scrollBy(a.h / 2)
	case KeyPgDn:
		a.scrollBy(-a.h / 2)
	case KeyCtrlX:
		a.openMenu()
	case KeyEsc:
		a.escAction()
	case KeyEnter:
		a.submit()
	case KeyAltEnter:
		a.edInsertLine()
	case KeyBackspace:
		a.edBackspace()
	case KeyDelete:
		a.edDelete()
	case KeyLeft:
		a.edLeft()
	case KeyRight:
		a.edRight()
	case KeyUp:
		a.edUp()
	case KeyDown:
		a.edDown()
	case KeyHome:
		a.edCol = 0
	case KeyEnd:
		a.edCol = runeLen(a.edLines[a.edRow])
	case KeyCtrlW:
		a.edDelWord()
	case KeyCtrlU:
		a.edLines[a.edRow] = ""
		a.edCol = 0
	case KeyRune:
		a.edInsert(ev.Rune)
	}
}

func (a *App) escAction() {
	if a.isRunning() {
		a.interrupt()
		return
	}
	if !a.edIsEmpty() {
		a.edClear()
		return
	}
	if a.offset > 0 {
		a.scrollBy(-1 << 30)
	}
}

func (a *App) interrupt() {
	a.mu.Lock()
	c := a.cancel
	if c != nil {
		a.status = "interrupting"
	}
	a.mu.Unlock()
	if c != nil {
		c()
	}
	a.println(Row{S("· interrupt requested — wrapping up the current step", SYellow)})
}

func (a *App) handleOverlayKey(ev Event) {
	ov := a.overlay
	switch ev.Key {
	case KeyUp:
		if ov.cur > 0 {
			ov.cur--
		}
	case KeyDown:
		if ov.cur < len(ov.items)-1 {
			ov.cur++
		}
	case KeyEnter:
		a.overlay = nil
		if ov.onPick != nil && ov.cur < len(ov.items) {
			ov.onPick(a, ov.cur)
		}
	case KeyEsc:
		a.overlay = nil
	}
}

/* -------------------------------- scrolling -------------------------------- */

func (a *App) scrollBy(delta int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	flat := a.flatLines()
	transH := 8
	if a.h/2 > transH {
		transH = a.h / 2
	}
	maxOff := len(flat) - transH + 2
	if maxOff < 0 {
		maxOff = 0
	}
	a.offset += delta
	if a.offset > maxOff {
		a.offset = maxOff
	}
	if a.offset < 0 {
		a.offset = 0
	}
	if a.offset == 0 {
		a.newBelow = 0
	}
}

/* ---------------------------------- editor --------------------------------- */

func runeLen(s string) int { return len([]rune(s)) }

func (a *App) edText() string { return strings.Join(a.edLines, "\n") }

func (a *App) edIsEmpty() bool { return len(a.edLines) == 1 && a.edLines[0] == "" }

func (a *App) edClear() {
	a.edLines = []string{""}
	a.edRow, a.edCol = 0, 0
}

func (a *App) edRecall(text string) {
	a.edLines = strings.Split(text, "\n")
	a.edRow = 0
	a.edCol = runeLen(a.edLines[len(a.edLines)-1])
	if a.edRow >= len(a.edLines) {
		a.edRow = len(a.edLines) - 1
	}
}

func (a *App) edInsert(r rune) {
	rs := []rune(a.edLines[a.edRow])
	a.edLines[a.edRow] = string(rs[:a.edCol]) + string(r) + string(rs[a.edCol:])
	a.edCol++
}

func (a *App) edInsertLine() {
	rs := []rune(a.edLines[a.edRow])
	head, tail := string(rs[:a.edCol]), string(rs[a.edCol:])
	rest := append([]string(nil), a.edLines[a.edRow+1:]...)
	a.edLines = append(a.edLines[:a.edRow], head)
	a.edLines = append(a.edLines, tail)
	a.edLines = append(a.edLines, rest...)
	a.edRow++
	a.edCol = 0
}

func (a *App) edBackspace() {
	if a.edCol > 0 {
		rs := []rune(a.edLines[a.edRow])
		a.edLines[a.edRow] = string(rs[:a.edCol-1]) + string(rs[a.edCol:])
		a.edCol--
		return
	}
	if a.edRow > 0 {
		prev := a.edLines[a.edRow-1]
		a.edCol = runeLen(prev)
		a.edLines[a.edRow-1] = prev + a.edLines[a.edRow]
		a.edLines = append(a.edLines[:a.edRow], a.edLines[a.edRow+1:]...)
		a.edRow--
	}
}

func (a *App) edDelete() {
	rs := []rune(a.edLines[a.edRow])
	if a.edCol < len(rs) {
		a.edLines[a.edRow] = string(rs[:a.edCol]) + string(rs[a.edCol+1:])
		return
	}
	if a.edRow < len(a.edLines)-1 {
		a.edLines[a.edRow] = a.edLines[a.edRow] + a.edLines[a.edRow+1]
		a.edLines = append(a.edLines[:a.edRow+1], a.edLines[a.edRow+2:]...)
	}
}

func (a *App) edLeft() {
	if a.edCol > 0 {
		a.edCol--
		return
	}
	if a.edRow > 0 {
		a.edRow--
		a.edCol = runeLen(a.edLines[a.edRow])
	}
}

func (a *App) edRight() {
	if a.edCol < runeLen(a.edLines[a.edRow]) {
		a.edCol++
		return
	}
	if a.edRow < len(a.edLines)-1 {
		a.edRow++
		a.edCol = 0
	}
}

func (a *App) edUp() {
	if len(a.edLines) == 1 {
		if a.histIdx > 0 {
			a.histIdx--
			a.edRecall(a.hist[a.histIdx])
		}
		return
	}
	if a.edRow > 0 {
		a.edRow--
		if a.edCol > runeLen(a.edLines[a.edRow]) {
			a.edCol = runeLen(a.edLines[a.edRow])
		}
	}
}

func (a *App) edDown() {
	if len(a.edLines) == 1 {
		if a.histIdx < len(a.hist) {
			a.histIdx++
			if a.histIdx >= len(a.hist) {
				a.edClear()
			} else {
				a.edRecall(a.hist[a.histIdx])
			}
		}
		return
	}
	if a.edRow < len(a.edLines)-1 {
		a.edRow++
		if a.edCol > runeLen(a.edLines[a.edRow]) {
			a.edCol = runeLen(a.edLines[a.edRow])
		}
	}
}

func (a *App) edDelWord() {
	rs := []rune(a.edLines[a.edRow])
	i := a.edCol
	for i > 0 && rs[i-1] == ' ' {
		i--
	}
	for i > 0 && rs[i-1] != ' ' {
		i--
	}
	a.edLines[a.edRow] = string(rs[:i]) + string(rs[a.edCol:])
	a.edCol = i
}

/* -------------------------------- submitting ------------------------------- */

func (a *App) logUser(text string) {
	ls := strings.Split(text, "\n")
	a.println(Row{S("> ", SDim), S(ls[0], SBold)})
	for _, l := range ls[1:] {
		a.println(Row{S("  "+l, 0)})
	}
}

func (a *App) submit() {
	text := strings.TrimSpace(a.edText())
	if text == "" {
		return
	}
	a.hist = append(a.hist, text)
	a.histIdx = len(a.hist)
	a.edClear()
	a.palOff = ""
	a.logUser(text)
	if strings.HasPrefix(text, "/") {
		a.command(text)
		return
	}
	if a.isRunning() {
		a.setNotice("a task is running — esc interrupts")
		return
	}
	if len(a.chain) == 0 {
		a.setNotice("no provider configured — check ~/.tagent/config.json")
		return
	}
	a.startRun(text)
}

func (a *App) command(text string) {
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return
	}
	switch strings.TrimPrefix(fields[0], "/") {
	case "model":
		a.openModelPicker()
	case "chain":
		a.openChain()
	case "diag":
		a.openDiag()
	case "clear":
		a.mu.Lock()
		a.log = nil
		a.flat = nil
		a.newBelow = 0
		a.conv = []LLMMessage{{Role: "system", Content: systemPrompt}}
		a.mu.Unlock()
	case "help":
		a.openHelp()
	case "exit", "quit":
		a.quit = true
	default:
		a.println(Row{S("unknown command "+fields[0]+" — /help lists commands", SRed)})
	}
}

func (a *App) startRun(task string) {
	ctx, cancel := context.WithCancel(context.Background())
	a.mu.Lock()
	a.running = true
	a.cancel = cancel
	a.status = ""
	a.mu.Unlock()
	chain := a.chain
	client := a.client
	conv := &a.conv
	go func() {
		start := time.Now()
		runTask(ctx, client, chain, a.wsPath, task, a.maxTurns, a, conv)
		cancel()
		a.mu.Lock()
		a.running = false
		a.cancel = nil
		a.status = ""
		a.lastDone = "done in " + durStr(time.Since(start))
		a.mu.Unlock()
	}()
}

/* ------------------------------ slash palette ------------------------------ */

func (a *App) palette() *palInfo {
	if len(a.edLines) != 1 || a.overlay != nil {
		return nil
	}
	first := a.edLines[0]
	if !strings.HasPrefix(first, "/") {
		return nil
	}
	token := strings.SplitN(first, " ", 2)[0]
	if a.palOff == token {
		return nil
	}
	name := strings.TrimPrefix(token, "/")
	var items []slashCmd
	for _, c := range slashCmds {
		if strings.HasPrefix(c.name, name) {
			items = append(items, c)
		}
	}
	if len(items) == 0 {
		return nil
	}
	if a.palCur >= len(items) {
		a.palCur = len(items) - 1
	}
	return &palInfo{token: token, items: items}
}

func (a *App) paletteComplete(run bool) {
	pal := a.palette()
	if pal == nil {
		if run {
			a.submit()
		}
		return
	}
	if a.palCur >= len(pal.items) {
		a.palCur = len(pal.items) - 1
	}
	sel := pal.items[a.palCur]
	a.edLines = []string{"/" + sel.name + " "}
	a.edRow, a.edCol = 0, runeLen(a.edLines[0])
	if run {
		a.submit()
	}
}

/* --------------------------------- overlays -------------------------------- */

func (a *App) openMenu() {
	a.overlay = &overlay{
		title: "menu — ctrl+x",
		items: []string{"switch model", "fallback chain", "diagnostics", "clear transcript", "help", "exit"},
		descs: []string{"pick from the provider chain", "ordered failover list",
			"config · keys · workspace", "wipe the transcript", "keys & commands", "quit tagent-native"},
		cur: 0,
		onPick: func(a *App, i int) {
			switch i {
			case 0:
				a.openModelPicker()
			case 1:
				a.openChain()
			case 2:
				a.openDiag()
			case 3:
				a.command("/clear")
				a.println(Row{S("transcript cleared", SDim)})
			case 4:
				a.openHelp()
			case 5:
				a.quit = true
			}
		},
	}
}

func (a *App) openModelPicker() {
	if len(a.chain) == 0 {
		a.setNotice("the chain is empty — configure ~/.tagent/config.json first")
		return
	}
	items := make([]string, len(a.chain))
	descs := make([]string, len(a.chain))
	for i, e := range a.chain {
		items[i] = e.Label
		descs[i] = e.Provider + " · " + e.Model
	}
	a.overlay = &overlay{
		title: "switch model",
		items: items,
		descs: descs,
		onPick: func(a *App, i int) {
			e := a.chain[i]
			if err := saveDefaultProvider(e.Provider, e.Model); err != nil {
				a.setNotice("could not save config: " + err.Error())
				return
			}
			a.cfg = loadConfig()
			a.chain = buildChain(a.cfg)
			if a.isRunning() {
				a.setNotice("switched — applies after the current run")
			}
			a.println(Row{S("switched to ", SDim), S(e.Label+" · "+e.Model, SGreen), S(" (saved)", SDim)})
		},
	}
}

func (a *App) openChain() {
	rows := []Row{{S("ordered failover — the first entry answers; on failure the next takes over", SDim)}}
	for i, e := range a.chain {
		rows = append(rows, Row{
			S(fmt.Sprintf("  %d ", i+1), SCyan),
			S(e.Label+" ", 0),
			S("· "+e.Model+" · "+e.Provider, SDim),
		})
	}
	if len(a.chain) == 0 {
		rows = append(rows, Row{S("  (empty — configure providers in ~/.tagent/config.json)", SRed)})
	}
	rows = append(rows, Row{}, Row{S("edit \"fallback\" in ~/.tagent/config.json to reorder", SDim)})
	a.overlay = &overlay{title: "fallback chain", text: rows}
}

func (a *App) openDiag() {
	cfgExists := "ok"
	if _, err := os.Stat(configPath()); err != nil {
		cfgExists = "missing"
	}
	provState := Row{}
	{
		var parts []Seg
		parts = append(parts, S("  ", 0))
		for _, p := range []string{"zai", "openrouter", "groq", "openai"} {
			if _, ok := a.cfg.APIKeys[p]; ok {
				parts = append(parts, S(p+" ", SGreen))
			} else {
				parts = append(parts, S(p+" ", SDim))
			}
		}
		if len(a.cfg.CustomProviders) > 0 {
			parts = append(parts, S(fmt.Sprintf("+%d custom", len(a.cfg.CustomProviders)), SCyan))
		}
		provState = Row(parts)
	}
	rows := []Row{
		{S("  version    ", SDim), S(fmt.Sprintf("tagent-native %s (%s/%s · %s)", a.version, runtime.GOOS, runtime.GOARCH, runtime.Version()), 0)},
		{S("  workspace  ", SDim), S(a.wsPath, 0)},
		{S("  config     ", SDim), S(configPath()+" ("+cfgExists+")", 0)},
		{S("  providers  ", SDim), S("green = key set · ", SDim)},
		provState,
		{S("  chain      ", SDim), S(fmt.Sprintf("%d entries", len(a.chain)), 0)},
		{S("  tls        ", SDim), S("TAGENT_TLS_SKIP="+os.Getenv("TAGENT_TLS_SKIP"), 0)},
	}
	a.overlay = &overlay{title: "diagnostics", text: rows}
}

func (a *App) openHelp() {
	rows := []Row{
		Row{S("keys", SBold)},
		{S("  enter          ", SDim), S("send the task", 0)},
		{S("  alt+enter      ", SDim), S("newline", 0)},
		{S("  ctrl+x         ", SDim), S("open the menu", 0)},
		{S("  pgup / pgdn    ", SDim), S("scroll the transcript", 0)},
		{S("  esc            ", SDim), S("interrupt a run · clear the box · jump to bottom", 0)},
		{S("  ctrl+c         ", SDim), S("exit", 0)},
		Row{S("commands", SBold)},
		{S("  /model         ", SDim), S("switch provider & model (saved to config)", 0)},
		{S("  /chain         ", SDim), S("view the fallback chain", 0)},
		{S("  /diag          ", SDim), S("diagnostics", 0)},
		{S("  /clear         ", SDim), S("clear the transcript & conversation", 0)},
		{S("  /help          ", SDim), S("this page", 0)},
		{S("  /exit          ", SDim), S("quit", 0)},
	}
	a.overlay = &overlay{title: "help", text: rows}
}

/* ------------------------------ frame building ----------------------------- */

func (a *App) buildFrame() []Row {
	W, H := a.w, a.h
	rows := []Row{a.headerRow(W)}
	edRows := a.editorRows(W)
	viewportH := H - 1 - 2 - len(edRows)
	if viewportH < 1 {
		viewportH = 1
	}
	ovRows := a.overlayRows(W, viewportH)
	transH := viewportH - len(ovRows)
	if transH < 0 {
		transH = 0
	}
	rows = append(rows, a.transcriptRows(transH)...)
	rows = append(rows, ovRows...)
	rows = append(rows, a.statusRow(W))
	rows = append(rows, edRows...)
	rows = append(rows, a.footerRow(W))
	for len(rows) < H {
		rows = append(rows, Row{})
	}
	if len(rows) > H {
		rows = rows[:H]
	}
	out := make([]Row, len(rows))
	for i, r := range rows {
		out[i] = fitRow(r, W)
	}
	return out
}

func (a *App) headerRow(W int) Row {
	left := Row{
		S(" "+a.wsName+" ", SBold),
		S(" NATIVE ", SBlack|SOnOrange),
	}
	if len(a.chain) > 0 {
		left = append(left, S(" "+a.chain[0].Model+" · chain "+fmt.Sprint(len(a.chain)), SDim))
	} else {
		left = append(left, S(" no provider ", SRed))
	}
	var right Row
	if a.running {
		right = Row{S(string(SPINNER[a.spin])+" working", SOrange)}
	} else if a.tokensIn+a.tokensOut > 0 {
		right = Row{S(fmt.Sprintf("%s in · %s out", fmtTok(a.tokensIn), fmtTok(a.tokensOut)), SDim)}
	}
	room := W - rowWidth(left) - rowWidth(right)
	if room > 0 {
		out := append(left, S(strings.Repeat(" ", room), 0))
		return append(out, right...)
	}
	return left // right dropped on narrow terminals
}

func (a *App) statusRow(W int) Row {
	if a.notice != "" {
		if time.Since(a.noticeAt) < noticeTTL {
			return Row{S(a.notice, SRed)}
		}
		a.notice = ""
	}
	if a.running {
		base := a.status
		if base == "" {
			base = "working"
		}
		return Row{S(string(SPINNER[a.spin]), SCyan), S("  "+base+" — esc interrupts", SDim)}
	}
	if a.newBelow > 0 && a.offset > 0 {
		return Row{S(fmt.Sprintf("%d new lines below — pgdn to follow", a.newBelow), SDim)}
	}
	if a.lastDone != "" {
		return Row{S(a.lastDone, SDim)}
	}
	return Row{}
}

func (a *App) footerRow(W int) Row {
	f := footerFull
	if W < 96 {
		f = footerShort
	}
	return Row{S(f, SDim)}
}

func (a *App) flatLines() []Row {
	if a.flat == nil || a.flatW != a.w {
		a.flat = nil
		for _, line := range a.log {
			a.flat = append(a.flat, wrapRow(line, a.w)...)
		}
		a.flatW = a.w
	}
	return a.flat
}

func (a *App) transcriptRows(h int) []Row {
	if h <= 0 {
		return nil
	}
	flat := a.flatLines()
	maxOff := len(flat) - h
	if maxOff < 0 {
		maxOff = 0
	}
	if a.offset > maxOff {
		a.offset = maxOff
	}
	bottom := len(flat) - a.offset
	top := bottom - h
	if top < 0 {
		top = 0
	}
	if bottom > len(flat) {
		bottom = len(flat)
	}
	out := make([]Row, h)
	copy(out, flat[top:bottom])
	return out
}

/* ------------------------------ editor rows -------------------------------- */

// cursorPos maps a rune column onto (visual wrap row, rune offset in it).
func cursorPos(segs []string, col int) (int, int) {
	r := 0
	for _, s := range segs {
		n := runeLen(s)
		if col <= n {
			return r, col
		}
		col -= n
		r++
	}
	return max(0, r-1), 0
}

func (a *App) editorRows(W int) []Row {
	innerW := W - 4
	if innerW < 4 {
		innerW = 4
	}
	all := make([][]string, len(a.edLines))
	totalVis := 0
	for i, l := range a.edLines {
		all[i] = wrapText(l, innerW)
		totalVis += len(all[i])
	}
	contentRows := totalVis
	if contentRows < 2 {
		contentRows = 2
	}
	if contentRows > 6 {
		contentRows = 6
	}
	rowsBefore := 0
	for i := 0; i < a.edRow && i < len(all); i++ {
		rowsBefore += len(all[i])
	}
	vr, vcol := 0, 0
	if a.edRow < len(all) {
		vr, vcol = cursorPos(all[a.edRow], a.edCol)
	}
	cursorVis := rowsBefore + vr
	if totalVis <= contentRows {
		a.edScroll = 0
	} else {
		if cursorVis < a.edScroll {
			a.edScroll = cursorVis
		}
		if cursorVis >= a.edScroll+contentRows {
			a.edScroll = cursorVis - contentRows + 1
		}
		if a.edScroll > totalVis-contentRows {
			a.edScroll = totalVis - contentRows
		}
	}

	bstyle := SDim
	if a.running {
		bstyle = SOrange
	}
	rows := []Row{{S(boxTL+strings.Repeat(boxHZ, innerW+2)+boxTR, bstyle)}}
	empty := a.edIsEmpty()
	ph := func() Row {
		return Row{S(" "+truncVis(editorHint, innerW-2)+" ", SDim)}
	}
	blank := func() Row { return Row{S(" ", 0)} }
	vis := 0
	phDone := false
	for li := 0; li < len(all) && vis < a.edScroll+contentRows; li++ {
		for si := 0; si < len(all[li]); si++ {
			at := vis
			vis++
			if at < a.edScroll || at >= a.edScroll+contentRows {
				continue
			}
			if empty {
				if !phDone {
					rows = append(rows, ph())
					phDone = true
				} else {
					rows = append(rows, blank())
				}
				continue
			}
			txt := all[li][si]
			if li == a.edRow && si == vr {
				rows = append(rows, cursorRow(txt, vcol, innerW))
			} else {
				rows = append(rows, textRow(txt, innerW))
			}
		}
	}
	for len(rows) < contentRows+1 {
		if empty && !phDone {
			rows = append(rows, ph())
			phDone = true
		} else {
			rows = append(rows, blank())
		}
	}
	rows = append(rows, Row{S(boxBL+strings.Repeat(boxHZ, innerW+2)+boxBR, bstyle)})
	return rows
}

// cursorRow renders one editor line with the cursor cell reversed.
func cursorRow(txt string, col, innerW int) Row {
	rs := []rune(txt)
	var mid Row
	if col >= len(rs) {
		mid = Row{S(string(rs), 0), S(" ", SReverse)}
	} else {
		mid = Row{S(string(rs[:col]), 0), S(string(rs[col]), SReverse), S(string(rs[col+1:]), 0)}
	}
	return mid
}

func textRow(txt string, innerW int) Row {
	return Row{S(" ", 0), S(truncVis(txt, max(0, innerW-2)), 0)}
}

/* ------------------------------ overlay rows ------------------------------- */

func (a *App) overlayRows(W int, viewportH int) []Row {
	if a.overlay != nil {
		return a.renderOverlay(a.overlay, W, viewportH)
	}
	if pal := a.palette(); pal != nil {
		items := make([]string, len(pal.items))
		descs := make([]string, len(pal.items))
		for i, c := range pal.items {
			items[i] = "/" + c.name
			descs[i] = c.desc
		}
		title := "commands"
		if pal.token != "/" {
			title = "commands · " + pal.token
		}
		return renderBox(title, items, descs, a.palCur, nil,
			arrowsLbl+" move · tab complete · enter run · esc close", W, viewportH)
	}
	return nil
}

func (a *App) renderOverlay(ov *overlay, W int, viewportH int) []Row {
	if ov.text != nil {
		inner := make([]Row, 0, len(ov.text))
		for _, r := range ov.text {
			inner = append(inner, r)
		}
		return renderBox(ov.title, nil, nil, 0, inner, "enter / esc close", W, viewportH)
	}
	return renderBox(ov.title, ov.items, ov.descs, ov.cur, nil,
		arrowsLbl+" move · enter select · esc close", W, viewportH)
}

// renderBox draws a dialog: bordered, title embedded in the top edge.
func renderBox(title string, items, descs []string, cur int, text []Row, footer string, W int, viewportH int) []Row {
	innerW := W - 4
	if innerW < 8 {
		innerW = 8
	}
	// top edge with the embedded title
	t := " " + title + " "
	tW := visWidth(t)
	dash := innerW + 2 - 2 - tW
	if dash < 1 {
		dash = 1
		t = truncVis(t, innerW-1)
		tW = visWidth(t)
		dash = innerW + 2 - 2 - tW
	}
	rows := []Row{{S(boxTL+boxHZ+t+strings.Repeat(boxHZ, dash)+boxTR, SCyan)}}
	side := func(r Row) Row {
		out := Row{S(boxVT+" ", SCyan)}
		out = append(out, fitRow(r, innerW)...)
		return append(out, S(" "+boxVT, SCyan))
	}
	if text != nil {
		for _, r := range text {
			for _, wr := range wrapRow(r, innerW) {
				rows = append(rows, side(wr))
			}
		}
	} else {
		for i, it := range items {
			var r Row
			if i == cur {
				r = Row{S(cursorCh, SCyan), S(it, SBold)}
			} else {
				r = Row{S("  ", 0), S(it, 0)}
			}
			if i < len(descs) && descs[i] != "" {
				r = append(r, S("  — "+descs[i], SDim))
			}
			rows = append(rows, side(r))
		}
		rows = append(rows, side(Row{}))
		rows = append(rows, side(Row{S(footer, SDim)}))
	}
	rows = append(rows, Row{S(boxBL+strings.Repeat(boxHZ, innerW+2)+boxBR, SCyan)})

	// cap into the viewport
	maxH := viewportH
	if maxH < 4 {
		maxH = 4
	}
	if len(rows) > maxH {
		cut := rows[:maxH-2]
		cut = append(cut, Row{S(boxVT+" ", SCyan), S(" … more — enlarge the terminal ", SDim), S(" "+boxVT, SCyan)})
		cut = append(cut, rows[len(rows)-1])
		return cut
	}
	return rows
}

/* --------------------------------- helpers --------------------------------- */

func fmtTok(n int64) string {
	if n < 1000 {
		return fmt.Sprint(n)
	}
	return fmt.Sprintf("%.1fk", float64(n)/1000)
}

func durStr(d time.Duration) string {
	if d < time.Minute {
		return d.Round(100 * time.Millisecond).String()
	}
	m := int(d.Minutes())
	s := int(d.Seconds()) % 60
	return fmt.Sprintf("%dm%02ds", m, s)
}
