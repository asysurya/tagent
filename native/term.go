package main

// term.go — shared terminal UI primitives: key events, text styles, styled
// rows and CJK-aware width/wrapping helpers. The platform drivers
// (term_unix.go / term_windows.go) implement the Terminal interface on top.

import "strings"

/* --------------------------------- events --------------------------------- */

type Key int

const (
	KeyRune Key = iota
	KeyEnter
	KeyAltEnter
	KeyEsc
	KeyTab
	KeyBackspace
	KeyDelete
	KeyLeft
	KeyRight
	KeyUp
	KeyDown
	KeyHome
	KeyEnd
	KeyPgUp
	KeyPgDn
	KeyCtrlC
	KeyCtrlX
	KeyCtrlW
	KeyCtrlU
)

type Event struct {
	Key  Key
	Rune rune
}

/* --------------------------------- styles --------------------------------- */

type Style uint32

const (
	SDim Style = 1 << iota
	SBold
	SRed
	SGreen
	SYellow
	SBlue
	SMagenta
	SCyan
	SOrange
	SReverse
	SBlack    // black foreground (on colored chips)
	SOnCyan   // cyan background
	SOnOrange // orange background (yellow on 16-color consoles)
)

// Seg is one styled text run of a row.
type Seg struct {
	Text  string
	Style Style
}

func S(text string, st Style) Seg { return Seg{Text: text, Style: st} }

// Row is one screen line: a sequence of styled runs.
type Row []Seg

/* ------------------------------ width helpers ----------------------------- */

// cpWidth returns the display width of a code point (CJK ≈ 2).
func cpWidth(r rune) int {
	switch {
	case r >= 0x1100 && (r <= 0x115f ||
		r >= 0x2e80 && r <= 0xa4cf ||
		r >= 0xac00 && r <= 0xd7a3 ||
		r >= 0xf900 && r <= 0xfaff ||
		r >= 0xfe30 && r <= 0xfe4f ||
		r >= 0xff00 && r <= 0xff60 ||
		r >= 0xffe0 && r <= 0xffe6 ||
		r >= 0x1f300 && r <= 0x1f9ff):
		return 2
	}
	return 1
}

func visWidth(s string) int {
	w := 0
	for _, r := range s {
		w += cpWidth(r)
	}
	return w
}

func segWidth(s Seg) int { return visWidth(s.Text) }

func rowWidth(r Row) int {
	w := 0
	for _, s := range r {
		w += segWidth(s)
	}
	return w
}

// cutWidth splits s at a visible width boundary; rest may be empty.
func cutWidth(s string, w int) (string, string) {
	rs := []rune(s)
	used := 0
	for i, r := range rs {
		cw := cpWidth(r)
		if used+cw > w {
			return string(rs[:i]), string(rs[i:])
		}
		used += cw
	}
	return s, ""
}

// truncVis truncates plain text to a visible width.
func truncVis(s string, maxW int) string {
	t, _ := cutWidth(s, maxW)
	return t
}

// splitChunks splits text on spaces keeping the spaces attached to the
// preceding word — the unit a word-wrapper places per line.
func splitChunks(s string) []string {
	var out []string
	rs := []rune(s)
	i := 0
	for i < len(rs) {
		j := i
		for j < len(rs) && rs[j] != ' ' {
			j++
		}
		k := j
		for k < len(rs) && rs[k] == ' ' {
			k++
		}
		if k > i {
			out = append(out, string(rs[i:k]))
		}
		i = k
	}
	return out
}

// wrapText word-wraps plain text (editor lines); never returns zero lines.
func wrapText(s string, w int) []string {
	if w < 4 {
		w = 4
	}
	if visWidth(s) <= w {
		return []string{s}
	}
	var out []string
	cur := ""
	for _, chunk := range splitChunks(s) {
		for {
			if visWidth(cur)+visWidth(chunk) <= w {
				cur += chunk
				break
			}
			if cur != "" {
				out = append(out, cur)
				cur = ""
				continue
			}
			piece, rest := cutWidth(chunk, w)
			out = append(out, piece)
			chunk = rest
		}
	}
	if cur != "" {
		out = append(out, cur)
	}
	if len(out) == 0 {
		out = []string{""}
	}
	return out
}

// wrapRow word-wraps a styled row, preserving per-seg styles.
func wrapRow(row Row, w int) []Row {
	if w < 4 {
		w = 4
	}
	if rowWidth(row) <= w {
		return []Row{row}
	}
	var out []Row
	var cur Row
	curW := 0
	place := func(seg Seg) {
		cur = append(cur, seg)
		curW += segWidth(seg)
	}
	for _, seg := range row {
		for _, chunk := range splitChunks(seg.Text) {
			st := seg.Style
			for chunk != "" {
				if curW+visWidth(chunk) <= w {
					place(Seg{chunk, st})
					break
				}
				if curW > 0 { // wrap before the word
					out = append(out, cur)
					cur, curW = nil, 0
					continue
				}
				piece, rest := cutWidth(chunk, w) // word wider than the line
				place(Seg{piece, st})
				out = append(out, cur)
				cur, curW = nil, 0
				chunk = rest
			}
		}
	}
	if len(cur) > 0 {
		out = append(out, cur)
	}
	if len(out) == 0 {
		out = []Row{{}}
	}
	return out
}

// fitRow truncates + pads a styled row to exactly w columns.
func fitRow(r Row, w int) Row {
	out := Row{}
	used := 0
	for _, seg := range r {
		room := w - used
		if room <= 0 {
			break
		}
		if seg.Text == "" {
			continue
		}
		if segWidth(seg) <= room {
			out = append(out, seg)
			used += segWidth(seg)
		} else {
			piece, _ := cutWidth(seg.Text, room)
			if piece != "" {
				out = append(out, Seg{piece, seg.Style})
			}
			break
		}
	}
	if pad := w - used; pad > 0 {
		out = append(out, Seg{strings.Repeat(" ", pad), 0})
	}
	return out
}

/* ------------------------------ the driver API ---------------------------- */

// Terminal is the platform surface the app renders through.
type Terminal interface {
	Open() error                    // raw mode + screen takeover
	Close()                         // restore everything
	Size() (w, h int)               // current size in cells
	PollEvent(ms int) (Event, bool) // false = timeout (tick)
	Draw(rows []Row)                // paint a full frame (len(rows) == h)
}
