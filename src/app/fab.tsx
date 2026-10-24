// Floating action button — what the overlay renders while the shell is in
// fab mode (56px window). Click expands to the full UI, drag repositions,
// right-click quits the overlay process.
import { SettingsIcon } from 'lucide-preact';
import { host } from './core/host';

const DRAG_THRESHOLD = 4; // px of movement before a press becomes a drag

export function Fab() {
  let dragging = false;

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    dragging = false;
    const sx = e.screenX;
    const sy = e.screenY;

    // A plain click expands; once the pointer moves past the threshold we
    // hand off to the native caption-move loop — which then owns the rest
    // of the gesture (mouseup never reaches the page, so no click fires).
    const onMove = (ev: MouseEvent) => {
      if (dragging) return;
      if (Math.hypot(ev.screenX - sx, ev.screenY - sy) > DRAG_THRESHOLD) {
        dragging = true;
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('mouseup', onUp, true);
        host.drag(); // → wails:drag
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  };

  const onClick = () => {
    if (!dragging) host.expand();
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    host.quit();
  };

  return (
    <div
      class="grid h-screen w-screen cursor-default place-items-center bg-transparent"
      title="GearSwap UI — click to open · drag to move · right-click to quit"
      onContextMenu={onContextMenu}
    >
      <button
        class="grid h-12 w-12 cursor-pointer place-items-center rounded-full bg-slate-800 text-sky-400 shadow-lg shadow-black/60 ring-1 ring-slate-600 transition hover:bg-slate-700 hover:text-sky-300"
        onMouseDown={onMouseDown}
        onClick={onClick}
      >
        <SettingsIcon size={24} />
      </button>
    </div>
  );
}
