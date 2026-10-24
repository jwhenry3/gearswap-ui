// gsui-overlay — Wails v3 (WebView2) shell for the GearSwap UI addon.
//
// Thin window wrapper: the Lua addon's HTTP server stays the backend, this
// process just finds it (probing 127.0.0.1:17890..17899 for /api/status,
// or $GSUI_PORT if set) and shows it in a frameless always-on-top window.
//
// Window chrome on the navigated page works through Wails' own message
// channel — Wails v3 routes "wails:drag" / "wails:resize:<cursor>" from any
// main-frame origin, so the page posts those raw strings via
// chrome.webview.postMessage. "gsui:hide" / "gsui:quit" land in
// RawMessageHandler. No runtime injection needed.
//
// Build:
//
//	go build -tags production -ldflags "-s -w -H windowsgui" \
//	    -o ../../addon/gearswapui/overlay/gsui-overlay.exe .
package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

const windowTitle = "GearSwap UI"

// ---------------------------------------------------------------- win32

var (
	user32 = syscall.NewLazyDLL("user32.dll")

	pIsWindowVisible     = user32.NewProc("IsWindowVisible")
	pIsIconic            = user32.NewProc("IsIconic")
	pShowWindow          = user32.NewProc("ShowWindow")
	pSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	pGetForegroundWindow = user32.NewProc("GetForegroundWindow")
	pSetWindowPos        = user32.NewProc("SetWindowPos")
)

const (
	swRestore     = 9
	hwndTopmost   = ^uintptr(0) // (HWND)-1
	swpNoSize     = 0x0001
	swpNoMove     = 0x0002
	swpNoActivate = 0x0010
	swpShowWindow = 0x0040
)

// hwnd of the overlay window once NativeWindow() reports it
var windowHwnd atomic.Uintptr

func isIconic(hwnd uintptr) bool {
	r, _, _ := pIsIconic.Call(hwnd)
	return r != 0
}

func isVisible(hwnd uintptr) bool {
	r, _, _ := pIsWindowVisible.Call(hwnd)
	return r != 0
}

func foreground() uintptr {
	r, _, _ := pGetForegroundWindow.Call()
	return r
}

// keepPinned re-asserts topmost z-order and un-minimizes — frameless
// tool windows get buried by the game asserting its own topmost, and
// auto-minimized when the game takes focus. Skips re-pinning while our
// window is foreground so window-level popups keep their activation.
func keepPinned(win *application.WebviewWindow) {
	var hwnd uintptr
	for hwnd == 0 {
		if p := win.NativeWindow(); p != nil {
			hwnd = uintptr(p)
		}
		time.Sleep(150 * time.Millisecond)
	}
	windowHwnd.Store(hwnd)

	for {
		time.Sleep(2 * time.Second)
		if !isVisible(hwnd) {
			continue // hidden via Esc
		}
		if isIconic(hwnd) {
			pShowWindow.Call(hwnd, swRestore)
			continue
		}
		if foreground() == hwnd {
			continue
		}
		pSetWindowPos.Call(hwnd, hwndTopmost, 0, 0, 0, 0,
			swpNoMove|swpNoSize|swpNoActivate|swpShowWindow)
	}
}

// ---------------------------------------------------------- port probing

// probeTarget blocks until the addon server answers /api/status on one of
// the candidate ports (the addon binds the first free port in a range).
func probeTarget() string {
	if p := os.Getenv("GSUI_PORT"); p != "" {
		return fmt.Sprintf("http://127.0.0.1:%s/", p)
	}
	client := &http.Client{Timeout: 400 * time.Millisecond}
	for {
		for port := 17890; port <= 17899; port++ {
			resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/api/status", port))
			if err != nil {
				continue
			}
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return fmt.Sprintf("http://127.0.0.1:%d/", port)
			}
		}
		time.Sleep(time.Second)
	}
}

// ------------------------------------------------------------ splash page

// Shown until SetURL navigates to the addon server once it's found.
const splashHTML = `<!doctype html>
<meta charset="utf-8">
<style>
  html,body{background:#020617;color:#94a3b8;height:100%;margin:0;
    font:14px system-ui;display:grid;place-items:center}
  .spin{color:#38bdf8}
</style>
<p>connecting to the gearswapui addon<span class="spin">…</span></p>
`

func dataDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.TempDir()
	}
	d := filepath.Join(base, "gearswapui")
	os.MkdirAll(d, 0o755)
	return d
}

func main() {
	logf, err := os.OpenFile(filepath.Join(dataDir(), "overlay.log"),
		os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err == nil {
		log.SetOutput(logf)
		defer logf.Close()
	}

	var win *application.WebviewWindow
	var app *application.App
	app = application.New(application.Options{
		Name: "gearswapui-overlay",
		// //gsui overlay can fire repeatedly — surface the existing window
		// instead of stacking instances.
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "com.gearswapui.overlay",
			OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
				if win == nil {
					return
				}
				win.Show()
				win.Focus()
				if hwnd := windowHwnd.Load(); hwnd != 0 {
					if isIconic(hwnd) {
						pShowWindow.Call(hwnd, swRestore)
					}
					pSetForegroundWindow.Call(hwnd)
				}
			},
		},
		// the page is a foreign-origin document — Wails' own "wails:*"
		// messages reach HandleMessage directly, anything else lands here
		RawMessageHandler: func(w application.Window, message string, _ *application.OriginInfo) {
			switch message {
			case "gsui:hide":
				win.Hide()
			case "gsui:quit":
				app.Quit()
			}
		},
		Windows: application.WindowsOptions{
			// own UDF so we never collide with another app's WebView2 profile
			WebviewUserDataPath: filepath.Join(dataDir(), "webview2"),
		},
	})

	win = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            windowTitle,
		Width:            1100,
		Height:           760,
		MinWidth:         860,
		MinHeight:        520,
		Frameless:        true,
		AlwaysOnTop:      true,
		BackgroundColour: application.NewRGB(2, 6, 23), // --background #020617
		HTML:             splashHTML,
		Windows: application.WindowsWindow{
			HiddenOnTaskbar:                   true,
			DisableFramelessWindowDecorations: true,
		},
	})

	// frameless+tool windows auto-minimize when the game takes focus — undo it
	win.OnWindowEvent(events.Common.WindowMinimise, func(e *application.WindowEvent) {
		win.Show()
	})

	go keepPinned(win)
	go func() {
		// SetURL is a no-op until app.Run creates the window impl —
		// NativeWindow() reporting an hwnd means it's ready.
		for win.NativeWindow() == nil {
			time.Sleep(150 * time.Millisecond)
		}
		win.SetURL(probeTarget())
	}()

	if err := app.Run(); err != nil {
		log.Printf("wails exited with error: %v", err)
	}
}
