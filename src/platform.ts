export interface MenuAnchor {
  x: number;
  y: number;
}

function desktopMenus(): boolean {
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|Mobile/i.test(ua)) return false;
  return /Windows|X11|Linux/.test(ua);
}

// Touch-first devices type on a soft keyboard, which closes when the focused
// control is disabled and does not reopen on a programmatic focus.
export function softKeyboard(): boolean {
  return (
    window.matchMedia("(pointer: coarse)").matches ||
    /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)
  );
}

export function anchorMenu(
  menu: HTMLElement,
  sheet: HTMLElement,
  at?: MenuAnchor,
): void {
  if (!at || !desktopMenus()) return;
  menu.classList.add("popup");
  const rect = sheet.getBoundingClientRect();
  const x = Math.max(8, Math.min(at.x, window.innerWidth - rect.width - 8));
  const y = Math.max(8, Math.min(at.y, window.innerHeight - rect.height - 8));
  sheet.style.left = `${x}px`;
  sheet.style.top = `${y}px`;
}
