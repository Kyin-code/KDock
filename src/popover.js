/**
 * Shared dismissal behavior for popover-like <details> elements.
 * Clicking outside or pressing Escape closes them; clicks inside are untouched.
 */
export function bindPopoverDismissal(root = document, selector = "details.more[open]") {
  const openPopovers = () => [...root.querySelectorAll(selector)];
  const closeAll = () => {
    let closed = false;
    for (const popover of openPopovers()) {
      popover.open = false;
      closed = true;
    }
    return closed;
  };
  const onPointerDown = (event) => {
    for (const popover of openPopovers()) {
      if (!(event.target instanceof Node) || !popover.contains(event.target)) popover.open = false;
    }
  };
  const onKeyDown = (event) => {
    if (event.key !== "Escape") return;
    if (closeAll()) event.preventDefault();
  };
  root.addEventListener("pointerdown", onPointerDown, true);
  root.addEventListener("keydown", onKeyDown, true);
  return () => {
    root.removeEventListener("pointerdown", onPointerDown, true);
    root.removeEventListener("keydown", onKeyDown, true);
  };
}
