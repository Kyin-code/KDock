/** Page-oriented help renderer. Loaded with the help content, not in the
 *  initial app bundle. */
export function createHelpRenderer({
  groups,
  getLang,
  translate,
  titleOf,
  textOf,
  onSelectGroup,
  onOpenItem,
  doc = document,
}) {
  const $ = (id) => doc.getElementById(id);
  const lang = () => getLang() === "en" ? "en" : "zh";
  const pageCountText = (count) =>
    lang() === "en" ? `${count} ${count === 1 ? "page" : "pages"}` : `${count} 页`;
  const topicCountText = (count) =>
    lang() === "en" ? `${count} ${count === 1 ? "topic" : "topics"}` : `${count} 个主题`;
  const padIndex = (index) => String(index + 1).padStart(2, "0");
  const normalize = (value) => String(value || "").trim().toLocaleLowerCase();

  const groupIndex = (title) =>
    Math.max(0, groups.findIndex((group) => group.title === title));

  const groupForItem = (id) => {
    for (const [index, group] of groups.entries()) {
      const item = group.items.find((entry) => entry.id === id);
      if (item) return { group, item, index };
    }
    return null;
  };

  const setActiveGroup = (groupTitle) => {
    for (const button of doc.querySelectorAll("#help-nav .helppagebtn")) {
      const active = button.dataset.helpGroup === groupTitle;
      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    }
  };

  const filterNav = (query) => {
    const nav = $("help-nav");
    if (!nav) return;
    const wanted = normalize(query);
    let visible = 0;
    for (const button of nav.querySelectorAll(".helppagebtn")) {
      const match = !wanted || (button.dataset.search || "").includes(wanted);
      button.hidden = !match;
      if (match) visible += 1;
    }
    const count = $("help-page-count");
    if (count) {
      count.textContent = wanted ? `${visible} / ${groups.length}` : pageCountText(groups.length);
    }
    const empty = $("help-nav-empty");
    if (empty) empty.hidden = visible !== 0;
  };

  const renderNav = (nav, activeGroup = "") => {
    if (!nav) return;
    nav.innerHTML = "";
    groups.forEach((group, index) => {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "helppagebtn";
      button.dataset.helpGroup = group.title;
      button.dataset.search = [
        group.title,
        translate(group.title),
        ...group.items.flatMap((item) => [item.title, titleOf(item), item.zh, item.en]),
      ].join(" ").toLocaleLowerCase();
      button.title = group.items.map(titleOf).join(" · ");

      const number = doc.createElement("span");
      number.className = "helppagebtn-index";
      number.textContent = padIndex(index);
      const copy = doc.createElement("span");
      copy.className = "helppagebtn-copy";
      const title = doc.createElement("b");
      title.textContent = translate(group.title);
      const count = doc.createElement("small");
      count.textContent = topicCountText(group.items.length);
      copy.append(title, count);
      button.append(number, copy);
      button.onclick = () => onSelectGroup(group.title);
      nav.appendChild(button);
    });
    filterNav($("help-search")?.value || "");
    setActiveGroup(activeGroup);
  };

  const renderIndex = (box) => {
    if (!box) return;
    box.innerHTML = "";
    for (const group of groups) {
      const button = doc.createElement("button");
      button.type = "button";
      button.dataset.help = group.items[0]?.id || "";
      const title = doc.createElement("span");
      title.textContent = translate(group.title);
      const detail = doc.createElement("small");
      detail.textContent =
        `${topicCountText(group.items.length)} · ${group.items.map(titleOf).join(" · ")}`;
      button.append(title, detail);
      button.onclick = () => onOpenItem(group.items[0]?.id);
      box.appendChild(button);
    }
  };

  const renderText = (item, container) => {
    let list = null;
    let subsection = null;
    for (const raw of textOf(item).split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("### ")) {
        list = null;
        subsection = doc.createElement("div");
        subsection.className = "helpsub";
        const heading = line.slice(4);
        if (/^(联动|Relationships?|Relationship)$/i.test(heading)) {
          subsection.classList.add("help-related");
        }
        const h4 = doc.createElement("h4");
        h4.textContent = heading;
        subsection.appendChild(h4);
        container.appendChild(subsection);
      } else if (line.startsWith("- ")) {
        if (!list) {
          list = doc.createElement("ul");
          (subsection || container).appendChild(list);
        }
        const li = doc.createElement("li");
        li.textContent = line.slice(2);
        list.appendChild(li);
      } else {
        list = null;
        const p = doc.createElement("p");
        p.textContent = line;
        (subsection || container).appendChild(p);
      }
    }
  };

  const updatePager = (index) => {
    const previous = groups[index - 1];
    const next = groups[index + 1];
    const previousButton = $("help-prev");
    const nextButton = $("help-next");
    if (previousButton) {
      previousButton.disabled = !previous;
      previousButton.onclick = previous ? () => onSelectGroup(previous.title) : null;
    }
    if (nextButton) {
      nextButton.disabled = !next;
      nextButton.onclick = next ? () => onSelectGroup(next.title) : null;
    }
    const previousTitle = $("help-prev-title");
    const nextTitle = $("help-next-title");
    if (previousTitle) previousTitle.textContent = previous ? translate(previous.title) : "—";
    if (nextTitle) nextTitle.textContent = next ? translate(next.title) : "—";
    const position = $("help-position");
    if (position) position.textContent = `${index + 1} / ${groups.length}`;
  };

  const renderPage = (index, anchorId = "", focusAnchor = false) => {
    const safeIndex = Math.max(0, Math.min(index, groups.length - 1));
    const group = groups[safeIndex];
    if (!group) return null;
    setActiveGroup(group.title);
    const active = doc.querySelector(
      `#help-nav .helppagebtn[data-help-group="${group.title}"]`,
    );
    if (active?.scrollIntoView) active.scrollIntoView({ block: "nearest" });

    const crumb = $("help-crumb");
    if (crumb) crumb.textContent = `${translate("帮助中心")} / ${translate(group.title)}`;
    const label = $("help-page-label");
    if (label) label.textContent = `${translate(group.title)} · ${topicCountText(group.items.length)}`;

    const body = $("help-body");
    if (!body) return { group, currentId: anchorId || group.items[0]?.id || "" };
    body.innerHTML = "";
    const heading = doc.createElement("h2");
    heading.textContent = translate(group.title);
    const lead = doc.createElement("p");
    lead.className = "helpdoclead";
    lead.textContent = lang() === "en"
      ? `${group.items.length} topics on this page. Search the sidebar or use Previous / Next to switch pages.`
      : `本页共 ${group.items.length} 个主题，可搜索左侧页面或使用底部的上一页 / 下一页切换。`;
    body.append(heading, lead);

    group.items.forEach((item, itemIndex) => {
      const section = doc.createElement("section");
      section.className = "helpitem";
      section.id = item.id;
      section.dataset.helpItem = item.id;
      const head = doc.createElement("div");
      head.className = "helpitem-head";
      const number = doc.createElement("span");
      number.className = "helpitem-index";
      number.textContent = padIndex(itemIndex);
      const title = doc.createElement("h3");
      title.textContent = titleOf(item);
      head.append(number, title);
      const content = doc.createElement("div");
      content.className = "helpitem-body";
      renderText(item, content);
      section.append(head, content);
      body.appendChild(section);
    });
    updatePager(safeIndex);

    const scrollHost = body.closest(".helpdoc");
    if (scrollHost) scrollHost.scrollTop = 0;
    if (focusAnchor && anchorId && scrollHost) {
      requestAnimationFrame(() => {
        const target = body.querySelector(`[data-help-item="${anchorId}"]`);
        if (!target) return;
        scrollHost.scrollTop +=
          target.getBoundingClientRect().top - scrollHost.getBoundingClientRect().top - 18;
        target.classList.add("target");
        setTimeout(() => target.classList.remove("target"), 900);
      });
    }
    return { group, currentId: anchorId || group.items[0]?.id || "" };
  };

  return {
    filterNav,
    groupForItem,
    groupIndex,
    renderIndex,
    renderNav,
    renderPage,
  };
}
