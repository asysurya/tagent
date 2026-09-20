//go:build !windows

package main

// term_unix.go — the ANSI terminal driver (Linux, macOS, BSDs with termios).
// Raw mode via ioctl, a background reader pump, and a small state machine
// that decodes keystrokes / escape sequences into Events.

import (
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
	"unsafe"
)

var (
	ioctlReadTerm, ioctlWriteTerm, ioctlWinsz uint
)

func init() {
	switch runtime.GOOS {
	case "linux":
		ioctlReadTerm, ioctlWriteTerm, ioctlWinsz = 0x5401, 0x5402, 0x5413
	case "darwin":
		ioctlReadTerm, ioctlWriteTerm, ioctlWinsz = 0x40487413, 0x80487414, 0x40087468
	}
}

func ioctlPtr(fd int, req uint, p unsafe.Pointer) error {
	_, _, errno := syscall.Syscall6(syscall.SYS_IOCTL, uintptr(fd), uintptr(req), uintptr(p), 0, 0, 0)
	if errno != 0 {
		return errno
	}
	return nil
}

type unixTerm struct {
	mu    sync.Mutex
	fd    int
	saved syscall.Termios

	events     chan []byte // raw chunks from the reader pump
	closed     bool
	buf        []byte
	queue      []Event
	escPending bool
}

var _ Terminal = (*unixTerm)(nil)

func stdoutIsTTY() bool {
	var t syscall.Termios
	return ioctlReadTerm != 0 && ioctlPtr(int(os.Stdout.Fd()), ioctlReadTerm, unsafe.Pointer(&t)) == nil
}

func openTerminal() (Terminal, error) {
	if ioctlReadTerm == 0 {
		return nil, fmt.Errorf("raw terminal not supported on %s", runtime.GOOS)
	}
	t := &unixTerm{fd: int(os.Stdin.Fd()), events: make(chan []byte, 64)}
	var zero syscall.Termios
	if err := ioctlPtr(t.fd, ioctlReadTerm, unsafe.Pointer(&zero)); err != nil {
		return nil, fmt.Errorf("stdin is not a terminal")
	}
	if err := ioctlPtr(t.fd, ioctlReadTerm, unsafe.Pointer(&t.saved)); err != nil {
		return nil, err
	}
	raw := t.saved
	raw.Iflag &^= syscall.IGNBRK | syscall.BRKINT | syscall.PARMRK | syscall.ISTRIP |
		syscall.INLCR | syscall.IGNCR | syscall.ICRNL | syscall.IXON
	raw.Oflag &^= syscall.OPOST
	raw.Lflag &^= syscall.ECHO | syscall.ECHONL | syscall.ICANON | syscall.ISIG | syscall.IEXTEN
	raw.Cflag &^= syscall.CSIZE | syscall.PARENB
	raw.Cflag |= syscall.CS8
	raw.Cc[syscall.VMIN] = 1
	raw.Cc[syscall.VTIME] = 0
	if err := ioctlPtr(t.fd, ioctlWriteTerm, unsafe.Pointer(&raw)); err != nil {
		return nil, err
	}
	go t.pump()
	return t, nil
}

func (t *unixTerm) pump() {
	buf := make([]byte, 256)
	for {
		n, err := os.Stdin.Read(buf)
		if n > 0 {
			t.mu.Lock()
			closed := t.closed
			t.mu.Unlock()
			if closed {
				return
			}
			t.events <- append([]byte(nil), buf[:n]...)
		}
		if err != nil {
			close(t.events)
			return
		}
	}
}

func (t *unixTerm) Open() error {
	os.Stdout.WriteString("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H")
	return nil
}

func (t *unixTerm) Close() {
	t.mu.Lock()
	t.closed = true
	t.mu.Unlock()
	os.Stdout.WriteString("\x1b[?25h\x1b[?1049l\x1b[0m\r\n")
	_ = ioctlPtr(t.fd, ioctlWriteTerm, unsafe.Pointer(&t.saved))
}

func (t *unixTerm) Size() (int, int) {
	var ws struct{ row, col, x, y uint16 }
	if err := ioctlPtr(t.fd, ioctlWinsz, unsafe.Pointer(&ws)); err != nil {
		return 80, 24
	}
	if ws.col == 0 || ws.row == 0 {
		return 80, 24
	}
	return int(ws.col), int(ws.row)
}

func (t *unixTerm) Draw(rows []Row) {
	var b strings.Builder
	b.WriteString("\x1b[?25l\x1b[H")
	for i, r := range rows {
		b.WriteString("\r\x1b[2K")
		writeRowANSI(&b, r)
		if i < len(rows)-1 {
			b.WriteString("\r\n")
		}
	}
	os.Stdout.WriteString(b.String())
}

func writeRowANSI(b *strings.Builder, r Row) {
	for _, seg := range r {
		if seg.Text == "" {
			continue
		}
		if seg.Style == 0 {
			b.WriteString(seg.Text)
			continue
		}
		b.WriteString("\x1b[0;" + sgrCodes(seg.Style) + "m")
		b.WriteString(seg.Text)
		b.WriteString("\x1b[0m")
	}
}

func sgrCodes(st Style) string {
	var parts []string
	if st&SDim != 0 {
		parts = append(parts, "2")
	}
	if st&SBold != 0 {
		parts = append(parts, "1")
	}
	if st&SReverse != 0 {
		parts = append(parts, "7")
	}
	if st&SBlack != 0 {
		parts = append(parts, "30")
	}
	if st&SRed != 0 {
		parts = append(parts, "31")
	}
	if st&SGreen != 0 {
		parts = append(parts, "32")
	}
	if st&SYellow != 0 {
		parts = append(parts, "33")
	}
	if st&SBlue != 0 {
		parts = append(parts, "34")
	}
	if st&SMagenta != 0 {
		parts = append(parts, "35")
	}
	if st&SCyan != 0 {
		parts = append(parts, "36")
	}
	if st&SOrange != 0 {
		parts = append(parts, "38;5;208")
	}
	if st&SOnCyan != 0 {
		parts = append(parts, "46")
	}
	if st&SOnOrange != 0 {
		parts = append(parts, "48;5;208")
	}
	return strings.Join(parts, ";")
}

func (t *unixTerm) PollEvent(ms int) (Event, bool) {
	for {
		if len(t.queue) > 0 {
			ev := t.queue[0]
			t.queue = t.queue[1:]
			return ev, true
		}
		if t.escPending {
			// Give an in-flight escape sequence 20ms to complete before
			// declaring it a bare Esc keypress.
			select {
			case chunk, ok := <-t.events:
				if !ok {
					return Event{}, false
				}
				t.buf = append(t.buf, chunk...)
			case <-time.After(20 * time.Millisecond):
				t.escPending = false
				t.queue = append(t.queue, Event{Key: KeyEsc})
				continue
			}
			t.parse()
			continue
		}
		var timer <-chan time.Time
		if ms > 0 {
			timer = time.After(time.Duration(ms) * time.Millisecond)
		}
		select {
		case chunk, ok := <-t.events:
			if !ok {
				return Event{}, false
			}
			t.buf = append(t.buf, chunk...)
			t.parse()
		case <-timer:
			return Event{}, false
		}
	}
}

// parse drains t.buf into t.queue.
func (t *unixTerm) parse() {
	for len(t.buf) > 0 {
		b := t.buf[0]
		if b == 0x1b {
			if len(t.buf) == 1 {
				t.buf = t.buf[1:]
				t.escPending = true
				return
			}
			switch t.buf[1] {
			case '[': // CSI … final byte 0x40–0x7e
				i := 2
				for i < len(t.buf) {
					c := t.buf[i]
					if c >= 0x40 && c <= 0x7e {
						break
					}
					i++
				}
				if i >= len(t.buf) {
					return // wait for the rest of the sequence
				}
				seq := string(t.buf[:i+1])
				t.buf = t.buf[i+1:]
				if ev, ok := csiEvent(seq); ok {
					t.queue = append(t.queue, ev)
				}
			case 'O': // SS3 A–D
				if len(t.buf) < 3 {
					return
				}
				seq := string(t.buf[1:3])
				t.buf = t.buf[3:]
				if ev, ok := csiEvent("\x1b[" + seq); ok {
					t.queue = append(t.queue, ev)
				}
			case '\r', '\n':
				t.buf = t.buf[2:]
				t.queue = append(t.queue, Event{Key: KeyAltEnter})
			default:
				t.buf = t.buf[1:]
				t.queue = append(t.queue, Event{Key: KeyEsc})
			}
			continue
		}
		switch b {
		case 0x03:
			t.queue = append(t.queue, Event{Key: KeyCtrlC})
			t.buf = t.buf[1:]
		case 0x18:
			t.queue = append(t.queue, Event{Key: KeyCtrlX})
			t.buf = t.buf[1:]
		case 0x17:
			t.queue = append(t.queue, Event{Key: KeyCtrlW})
			t.buf = t.buf[1:]
		case 0x15:
			t.queue = append(t.queue, Event{Key: KeyCtrlU})
			t.buf = t.buf[1:]
		case 0x0d, 0x0a:
			t.queue = append(t.queue, Event{Key: KeyEnter})
			t.buf = t.buf[1:]
		case 0x09:
			t.queue = append(t.queue, Event{Key: KeyTab})
			t.buf = t.buf[1:]
		case 0x7f, 0x08:
			t.queue = append(t.queue, Event{Key: KeyBackspace})
			t.buf = t.buf[1:]
		default:
			if b < 0x80 {
				t.queue = append(t.queue, Event{Key: KeyRune, Rune: rune(b)})
				t.buf = t.buf[1:]
			} else {
				r, size := utf8.DecodeRune(t.buf)
				if r == utf8.RuneError && size <= 1 {
					t.buf = t.buf[1:] // drop garbage
					continue
				}
				t.queue = append(t.queue, Event{Key: KeyRune, Rune: r})
				t.buf = t.buf[size:]
			}
		}
	}
}

func csiEvent(seq string) (Event, bool) {
	switch seq {
	case "\x1b[A":
		return Event{Key: KeyUp}, true
	case "\x1b[B":
		return Event{Key: KeyDown}, true
	case "\x1b[C":
		return Event{Key: KeyRight}, true
	case "\x1b[D":
		return Event{Key: KeyLeft}, true
	case "\x1b[H", "\x1b[1~", "\x1b[7~":
		return Event{Key: KeyHome}, true
	case "\x1b[F", "\x1b[4~", "\x1b[8~":
		return Event{Key: KeyEnd}, true
	case "\x1b[3~":
		return Event{Key: KeyDelete}, true
	case "\x1b[5~":
		return Event{Key: KeyPgUp}, true
	case "\x1b[6~":
		return Event{Key: KeyPgDn}, true
	}
	return Event{}, false
}
