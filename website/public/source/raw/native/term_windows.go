//go:build windows

package main

// term_windows.go — the Windows console driver.
//
// Windows 7's conhost does not understand ANSI escape sequences (VT support
// only arrived in Windows 10), so this driver paints through the classic
// console APIs: SetConsoleTextAttribute for colors, WriteConsoleW for
// Unicode text (box drawing works on Lucida Console / Consolas),
// ReadConsoleInputW for raw key events and SetConsoleCursorPosition for
// frame placement. Rounded box corners and braille spinners are not in
// Windows 7 console fonts — the app picks Win7-safe glyphs on this OS.

import (
	"fmt"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

var (
	k32                         = syscall.NewLazyDLL("kernel32.dll")
	procGetStdHandle            = k32.NewProc("GetStdHandle")
	procGetConsoleMode          = k32.NewProc("GetConsoleMode")
	procSetConsoleMode          = k32.NewProc("SetConsoleMode")
	procReadConsoleInputW       = k32.NewProc("ReadConsoleInputW")
	procGetNumConsoleInputEvt   = k32.NewProc("GetNumberOfConsoleInputEvents")
	procWaitForSingleObject     = k32.NewProc("WaitForSingleObject")
	procGetConsoleScreenBufInfo = k32.NewProc("GetConsoleScreenBufferInfo")
	procSetConsoleTextAttribute = k32.NewProc("SetConsoleTextAttribute")
	procSetConsoleCursorPos     = k32.NewProc("SetConsoleCursorPosition")
	procWriteConsoleW           = k32.NewProc("WriteConsoleW")
	procFillConsoleOutputCharW  = k32.NewProc("FillConsoleOutputCharacterW")
	procFillConsoleOutputAttr   = k32.NewProc("FillConsoleOutputAttribute")
	procGetConsoleCursorInfo    = k32.NewProc("GetConsoleCursorInfo")
	procSetConsoleCursorInfo    = k32.NewProc("SetConsoleCursorInfo")
)

const (
	stdInputHandle  = uintptr(0xFFFFFFF6) // (DWORD)-10
	stdOutputHandle = uintptr(0xFFFFFFF5) // (DWORD)-11

	enableProcessedInput = 0x0001
	enableLineInput      = 0x0002
	enableEchoInput      = 0x0004
	enableWindowInput    = 0x0008
	enableMouseInput     = 0x0010
	enableQuickEditMode  = 0x0040
	enableExtendedFlags  = 0x0080
)

type coord struct{ x, y int16 }
type smallRect struct{ left, top, right, bottom int16 }

type consoleScreenBufferInfo struct {
	dwSize              coord
	dwCursorPosition    coord
	wAttributes         uint16
	srWindow            smallRect
	dwMaximumWindowSize coord
}

type consoleCursorInfo struct {
	dwSize   uint32
	bVisible uint32
}

// inputRecord mirrors Win32 INPUT_RECORD for KEY_EVENT (20 bytes on 32/64-bit):
//
//	WORD EventType; union { KEY_EVENT_RECORD { BOOL bKeyDown; WORD repeat,
//	vk, scan; WCHAR ch; DWORD state } }.
type inputRecord [20]byte

func le16(b []byte, off int) uint16 { return uint16(b[off]) | uint16(b[off+1])<<8 }
func le32(b []byte, off int) uint32 {
	return uint32(le16(b, off)) | uint32(le16(b, off+2))<<16
}

type winTerm struct {
	hin, hout  syscall.Handle
	origIn     uint32
	origOut    uint32
	origCursor consoleCursorInfo
}

var _ Terminal = (*winTerm)(nil)

func getStdHandle(which uintptr) (syscall.Handle, error) {
	r, _, err := procGetStdHandle.Call(which)
	if r == 0 || r == ^uintptr(0) {
		return 0, fmt.Errorf("no std handle: %v", err)
	}
	return syscall.Handle(r), nil
}

func stdoutIsTTY() bool {
	h, err := getStdHandle(stdOutputHandle)
	if err != nil {
		return false
	}
	var mode uint32
	r, _, _ := procGetConsoleMode.Call(uintptr(h), uintptr(unsafe.Pointer(&mode)))
	return r != 0
}

func openTerminal() (Terminal, error) {
	hin, err := getStdHandle(stdInputHandle)
	if err != nil {
		return nil, fmt.Errorf("stdin is not a console")
	}
	hout, err := getStdHandle(stdOutputHandle)
	if err != nil {
		return nil, fmt.Errorf("stdout is not a console")
	}
	t := &winTerm{hin: hin, hout: hout}
	r, _, _ := procGetConsoleMode.Call(uintptr(hin), uintptr(unsafe.Pointer(&t.origIn)))
	if r == 0 {
		return nil, fmt.Errorf("stdin is not a console")
	}
	procGetConsoleMode.Call(uintptr(hout), uintptr(unsafe.Pointer(&t.origOut)))
	// raw input: no line buffer, no echo, no signal processing, no
	// quick-edit mouse selection (it stalls output), keep resize events.
	in := (t.origIn &^ (enableProcessedInput | enableLineInput | enableEchoInput | enableMouseInput)) |
		enableWindowInput | enableExtendedFlags
	procSetConsoleMode.Call(uintptr(hin), uintptr(in))
	procGetConsoleCursorInfo.Call(uintptr(hout), uintptr(unsafe.Pointer(&t.origCursor)))
	return t, nil
}

func (t *winTerm) Open() error {
	t.setCursorVisible(false)
	t.clearScreen()
	return nil
}

func (t *winTerm) Close() {
	procSetConsoleMode.Call(uintptr(t.hin), uintptr(t.origIn))
	t.setCursorVisible(t.origCursor.bVisible != 0)
	t.clearScreen()
	t.setPos(0, 0)
	procSetConsoleTextAttribute.Call(uintptr(t.hout), uintptr(t.origOut))
}

func (t *winTerm) setCursorVisible(v bool) {
	ci := consoleCursorInfo{dwSize: 20, bVisible: 0}
	if v {
		ci.bVisible = 1
	}
	procSetConsoleCursorInfo.Call(uintptr(t.hout), uintptr(unsafe.Pointer(&ci)))
}

func (t *winTerm) clearScreen() {
	var info consoleScreenBufferInfo
	r, _, _ := procGetConsoleScreenBufInfo.Call(uintptr(t.hout), uintptr(unsafe.Pointer(&info)))
	if r == 0 {
		return
	}
	w := int(info.srWindow.right-info.srWindow.left) + 1
	h := int(info.srWindow.bottom-info.srWindow.top) + 1
	var n uint32
	home := coord{0, 0}
	procSetConsoleTextAttribute.Call(uintptr(t.hout), uintptr(info.wAttributes))
	procFillConsoleOutputCharW.Call(uintptr(t.hout), uintptr(' '), uintptr(w*h), *(*uintptr)(unsafe.Pointer(&home)), uintptr(unsafe.Pointer(&n)))
	procFillConsoleOutputAttr.Call(uintptr(t.hout), uintptr(info.wAttributes), uintptr(w*h), *(*uintptr)(unsafe.Pointer(&home)), uintptr(unsafe.Pointer(&n)))
	t.setPos(0, 0)
}

func (t *winTerm) setPos(x, y int) {
	c := coord{int16(x), int16(y)}
	procSetConsoleCursorPos.Call(uintptr(t.hout), *(*uintptr)(unsafe.Pointer(&c)))
}

func (t *winTerm) Size() (int, int) {
	var info consoleScreenBufferInfo
	r, _, _ := procGetConsoleScreenBufInfo.Call(uintptr(t.hout), uintptr(unsafe.Pointer(&info)))
	if r == 0 {
		return 80, 24
	}
	w := int(info.srWindow.right-info.srWindow.left) + 1
	h := int(info.srWindow.bottom-info.srWindow.top) + 1
	if w < 4 || h < 2 {
		return 80, 24
	}
	return w, h
}

// winAttr maps a Style to a classic 16-color console attribute.
func winAttr(st Style) uint16 {
	hasColor := st&(SRed|SGreen|SYellow|SBlue|SMagenta|SCyan|SOrange) != 0
	var fg uint16
	switch {
	case st&SBlack != 0:
		fg = 0
	case st&SRed != 0:
		fg = 4
	case st&SOrange != 0, st&SYellow != 0:
		fg = 6
	case st&SGreen != 0:
		fg = 2
	case st&SBlue != 0:
		fg = 1
	case st&SMagenta != 0:
		fg = 5
	case st&SCyan != 0:
		fg = 3
	case st&SDim != 0:
		fg = 8 // dark gray
	default:
		fg = 7
	}
	if (hasColor && st&SDim == 0 && st&SBlack == 0) || (st&SBold != 0 && st&SBlack == 0) {
		fg |= 0x8 // bright variant
	}
	var bg uint16
	if st&SOnCyan != 0 {
		bg = 3
	}
	if st&SOnOrange != 0 {
		bg = 6 | 0x80 // bright yellow background ≈ orange
	}
	attr := fg | bg<<4
	if st&SReverse != 0 {
		attr = (attr & 0x000F) << 4 // swap fg into bg; fg becomes black
	}
	return attr
}

func (t *winTerm) writeW(s string) {
	w := utf16.Encode([]rune(s))
	if len(w) == 0 {
		return
	}
	var n uint32
	procWriteConsoleW.Call(uintptr(t.hout), uintptr(unsafe.Pointer(&w[0])), uintptr(len(w)), uintptr(unsafe.Pointer(&n)), 0)
}

func (t *winTerm) Draw(rows []Row) {
	w, h := t.Size()
	for y, row := range rows {
		if y >= h {
			break
		}
		t.setPos(0, y)
		lastRow := y == len(rows)-1
		written := 0
		var lastAttr uint16 = 7
		for _, seg := range row {
			txt := seg.Text
			if txt == "" {
				continue
			}
			if lastRow {
				room := (w - 1) - written
				if room <= 0 {
					break
				}
				if visWidth(txt) > room {
					txt = truncVis(txt, room)
				}
			}
			if txt == "" {
				continue
			}
			lastAttr = winAttr(seg.Style)
			procSetConsoleTextAttribute.Call(uintptr(t.hout), uintptr(lastAttr))
			t.writeW(txt)
			written += visWidth(txt)
		}
		if lastRow && written < w {
			// fill the remaining cells without moving the cursor — writing
			// through column w would scroll the buffer.
			var n uint32
			c := coord{int16(written), int16(y)}
			procSetConsoleTextAttribute.Call(uintptr(t.hout), uintptr(lastAttr))
			procFillConsoleOutputCharW.Call(uintptr(t.hout), uintptr(' '),
				uintptr(w-written), *(*uintptr)(unsafe.Pointer(&c)), uintptr(unsafe.Pointer(&n)))
		}
	}
	t.setPos(0, len(rows)-1)
}

func (t *winTerm) PollEvent(ms int) (Event, bool) {
	for {
		var pending uint32
		procGetNumConsoleInputEvt.Call(uintptr(t.hin), uintptr(unsafe.Pointer(&pending)))
		if pending == 0 {
			r1, _, _ := procWaitForSingleObject.Call(uintptr(t.hin), uintptr(ms))
			if r1 != 0 { // WAIT_OBJECT_0 == 0; anything else = timeout/failure
				return Event{}, false
			}
		}
		var recs [16]inputRecord
		var read uint32
		r, _, _ := procReadConsoleInputW.Call(uintptr(t.hin),
			uintptr(unsafe.Pointer(&recs[0])), uintptr(len(recs)), uintptr(unsafe.Pointer(&read)))
		if r == 0 || read == 0 {
			continue
		}
		for i := uint32(0); i < read; i++ {
			if ev, ok := keyFromRecord(&recs[i]); ok {
				return ev, true
			}
		}
	}
}

// keyFromRecord decodes a KEY_EVENT_RECORD (EventType == 1, bKeyDown).
// Offsets: 0 EventType; 4 bKeyDown; 8 repeat; 10 vk; 12 scan; 14 ch; 16 state.
func keyFromRecord(rec *inputRecord) (Event, bool) {
	if le16(rec[0:], 0) != 1 { // KEY_EVENT
		return Event{}, false
	}
	if le32(rec[0:], 4) == 0 { // key up
		return Event{}, false
	}
	vk := le16(rec[0:], 10)
	ch := le16(rec[0:], 14)
	state := le32(rec[0:], 16)
	const leftCtrl = 0x0008
	const leftAlt = 0x0002

	if ch == 0 { // non-character keys
		switch vk {
		case 0x25:
			return Event{Key: KeyLeft}, true
		case 0x26:
			return Event{Key: KeyUp}, true
		case 0x27:
			return Event{Key: KeyRight}, true
		case 0x28:
			return Event{Key: KeyDown}, true
		case 0x21:
			return Event{Key: KeyPgUp}, true
		case 0x22:
			return Event{Key: KeyPgDn}, true
		case 0x23:
			return Event{Key: KeyEnd}, true
		case 0x24:
			return Event{Key: KeyHome}, true
		case 0x2E:
			return Event{Key: KeyDelete}, true
		}
		return Event{}, false
	}
	switch ch {
	case 13:
		if state&leftAlt != 0 {
			return Event{Key: KeyAltEnter}, true
		}
		return Event{Key: KeyEnter}, true
	case 27:
		return Event{Key: KeyEsc}, true
	case 8:
		return Event{Key: KeyBackspace}, true
	case 9:
		return Event{Key: KeyTab}, true
	case 3:
		return Event{Key: KeyCtrlC}, true
	case 24:
		return Event{Key: KeyCtrlX}, true
	case 23:
		return Event{Key: KeyCtrlW}, true
	case 21:
		return Event{Key: KeyCtrlU}, true
	}
	if ch < 32 {
		return Event{}, false // unmapped control combos
	}
	if state&leftCtrl != 0 && ch >= 'A' && ch <= 'Z' {
		// typed ctrl+letter without a mapped meaning — swallow
		return Event{}, false
	}
	return Event{Key: KeyRune, Rune: rune(ch)}, true
}
