// gsui-overlay — Wails v3 (WebView2) shell for the GearSwap UI addon.
//
// Thin window wrapper: the Lua addon's HTTP server stays the backend, this
// process just finds it (probing 127.0.0.1:17890..17899 for /api/status,
// or $GSUI_PORT if set) and shows it in a frameless always-on-top window.
//
// The window has two modes:
//
//	fab  — a small always-on-top floating button (--fab starts this way).
//	       The addon spawns it on load; it survives //gsui hide/close/Esc.
//	full — the whole GearSwap UI.
//
// The page itself decides what to render from the viewport size, and talks
// to the shell through Wails' raw message channel — "wails:drag" /
// "wails:resize:<cursor>" are routed from any main-frame origin, while
// "gsui:expand|collapse|quit" land in RawMessageHandler.
//
// Build:
//
//	go build -tags production -ldflags "-s -w -H windowsgui" \
//	    -o ../../addon/gearswapui/overlay/gsui-overlay.exe .
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

const windowTitle = "GearSwap UI"

const (
	fabSize       = 56
	fullW, fullH  = 1100, 760
	minW, minH    = 860, 520
	fabEdgeMargin = 24
)

// ---------------------------------------------------------------- win32

var (
	user32 = syscall.NewLazyDLL("user32.dll")

	pIsWindowVisible     = user32.NewProc("IsWindowVisible")
	pIsIconic            = user32.NewProc("IsIconic")
	pShowWindow          = user32.NewProc("ShowWindow")
	pSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	pGetForegroundWindow = user32.NewProc("GetForegroundWindow")
	pSetWindowPos        = user32.NewProc("SetWindowPos")
	pGetSystemMetrics    = user32.NewProc("GetSystemMetrics")
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

func screenSize() (int, int) {
	cx, _, _ := pGetSystemMetrics.Call(0) // SM_CXSCREEN
	cy, _, _ := pGetSystemMetrics.Call(1) // SM_CYSCREEN
	return int(cx), int(cy)
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
			continue
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

// --------------------------------------------------------- geometry state

type rect struct{ X, Y, W, H int }

type geometry struct {
	Fab  *rect `json:"fab,omitempty"`
	Full *rect `json:"full,omitempty"`
}

var geom geometry
var geomPath string

func loadGeometry() {
	b, err := os.ReadFile(geomPath)
	if err == nil {
		json.Unmarshal(b, &geom)
	}
}

func saveGeometry() {
	if b, err := json.Marshal(geom); err == nil {
		os.WriteFile(geomPath, b, 0o644)
	}
}

// defaultFabPos parks the button in the bottom-right corner of the
// primary monitor.
func defaultFabPos() (int, int) {
	cx, cy := screenSize()
	return cx - fabSize - fabEdgeMargin, cy - fabSize - fabEdgeMargin
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
<p>connecting<span class="spin">…</span></p>
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

// --------------------------------------------------------------- modes

var (
	win     *application.WebviewWindow
	app     *application.App
	fabMode bool
)

// expand grows the fab back into the full window, restoring the bounds it
// had when it collapsed (or a centered default the first time).
func expand() {
	if !fabMode {
		return
	}
	log.Printf("expand: fab=%v", geom.Fab)
	x, y := win.Position()
	geom.Fab = &rect{X: x, Y: y, W: fabSize, H: fabSize}
	fabMode = false

	win.SetResizable(true)
	if r := geom.Full; r != nil && r.W >= minW && r.H >= minH {
		win.SetSize(r.W, r.H)
		win.SetPosition(r.X, r.Y)
	} else {
		win.SetSize(fullW, fullH)
		win.Center()
	}
	win.SetMinSize(minW, minH)
	win.Show()
	win.Focus()
	saveGeometry()
}

// collapse shrinks the window back to the fab, remembering the full
// bounds so expand can restore them.
func collapse() {
	if fabMode {
		return
	}
	fx, fy := win.Position()
	fw, fh := win.Size()
	geom.Full = &rect{X: fx, Y: fy, W: fw, H: fh}
	fabMode = true

	win.SetMinSize(fabSize, fabSize)
	win.SetSize(fabSize, fabSize)
	win.SetResizable(false)
	if geom.Fab != nil {
		win.SetPosition(geom.Fab.X, geom.Fab.Y)
	} else {
		x, y := defaultFabPos()
		win.SetPosition(x, y)
	}
	saveGeometry()
}

func quit() {
	// persist whichever geometry is live so the next launch restores it
	if fabMode {
		x, y := win.Position()
		geom.Fab = &rect{X: x, Y: y, W: fabSize, H: fabSize}
	} else {
		fx, fy := win.Position()
		fw, fh := win.Size()
		geom.Full = &rect{X: fx, Y: fy, W: fw, H: fh}
	}
	saveGeometry()
	app.Quit()
}

func main() {
	startFab := slices.Contains(os.Args[1:], "--fab")

	geomPath = filepath.Join(dataDir(), "window.json")
	loadGeometry()

	logf, err := os.OpenFile(filepath.Join(dataDir(), "overlay.log"),
		os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err == nil {
		log.SetOutput(logf)
		defer logf.Close()
	}

	app = application.New(application.Options{
		Name: "gearswapui-overlay",
		// //gsui overlay (and the addon's auto-fab spawn on load) can fire
		// repeatedly — surface the existing window instead of stacking.
		// A plain relaunch expands the UI; a --fab relaunch (addon reload)
		// just makes sure the button is visible.
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "com.gearswapui.overlay",
			OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
				log.Printf("second instance: args=%v", data.Args)
				if win == nil {
					return
				}
				go func() {
					if !slices.Contains(data.Args, "--fab") {
						expand()
					}
					win.Show()
					win.Focus()
					if hwnd := windowHwnd.Load(); hwnd != 0 {
						if isIconic(hwnd) {
							pShowWindow.Call(hwnd, swRestore)
						}
						pSetForegroundWindow.Call(hwnd)
					}
				}()
			},
		},
		// the page is a foreign-origin document — Wails' own "wails:*"
		// messages reach HandleMessage directly, anything else lands here.
		// win methods go through InvokeSync internally, so they must run
		// off the main thread that invokes this handler — hence the gos.
		RawMessageHandler: func(w application.Window, message string, _ *application.OriginInfo) {
			log.Printf("page message: %q", message)
			switch message {
			case "gsui:expand":
				go expand()
			case "gsui:collapse", "gsui:hide":
				go collapse()
			case "gsui:quit":
				go quit()
			}
		},
		Windows: application.WindowsOptions{
			// own UDF so we never collide with another app's WebView2 profile
			WebviewUserDataPath: filepath.Join(dataDir(), "webview2"),
		},
	})

	opts := application.WebviewWindowOptions{
		Title:       windowTitle,
		Frameless:   true,
		AlwaysOnTop: true,
		// transparent so the fab's square window reads as a circle —
		// the full page paints its own opaque background
		BackgroundType:   application.BackgroundTypeTransparent,
		BackgroundColour: application.NewRGB(2, 6, 23), // --background #020617
		HTML:             splashHTML,
		Windows: application.WindowsWindow{
			HiddenOnTaskbar:                   true,
			DisableFramelessWindowDecorations: true,
		},
	}
	if startFab {
		fabMode = true
		x, y := defaultFabPos()
		if geom.Fab != nil {
			x, y = geom.Fab.X, geom.Fab.Y
		}
		opts.Width, opts.Height = fabSize, fabSize
		opts.MinWidth, opts.MinHeight = fabSize, fabSize
		opts.X, opts.Y = x, y
		opts.DisableResize = true
	} else {
		opts.Width, opts.Height = fullW, fullH
		opts.MinWidth, opts.MinHeight = minW, minH
		if geom.Full != nil && geom.Full.W >= minW && geom.Full.H >= minH {
			opts.Width, opts.Height = geom.Full.W, geom.Full.H
			opts.X, opts.Y = geom.Full.X, geom.Full.Y
		}
	}
	win = app.Window.NewWithOptions(opts)

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
