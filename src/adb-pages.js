export const ADB_PAGES = ["connect", "mirror", "tools", "logs"];

export function showAdbPage(name, root = document, storage = localStorage) {
  const page = ADB_PAGES.includes(name) ? name : "connect";
  root.querySelectorAll(".adbtab").forEach((button) => {
    button.classList.toggle("active", button.dataset.adbp === page);
  });
  root.querySelectorAll(".adbpage").forEach((pane) => {
    pane.hidden = pane.dataset.adbpage !== page;
  });
  try {
    storage.setItem("kdock_adb_page", page);
  } catch (_) {}
  return page;
}
