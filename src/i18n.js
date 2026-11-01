import i18next from "i18next";

/**
 * Create the app translator. Chinese UI text remains the migration-period key,
 * so existing calls can move gradually without a risky one-shot rename.
 */
export function createI18n(en, initialLanguage) {
  const instance = i18next.createInstance();
  instance.init({
    lng: initialLanguage === "en" ? "en" : "zh",
    fallbackLng: "zh",
    resources: {
      zh: { translation: {} },
      en: { translation: en },
    },
    keySeparator: false,
    nsSeparator: false,
    returnNull: false,
    // Existing English copy contains literal `{{args}}`; use the small
    // interpolator below so missing runtime values never erase that text.
    interpolation: false,
    initImmediate: false,
  });
  return instance;
}

export function translate(instance, language, key, values = {}) {
  let text = instance.t(key, {
    lng: language === "en" ? "en" : "zh",
    defaultValue: key,
  });
  for (const [name, value] of Object.entries(values)) {
    text = text.split(`{{${name}}}`).join(String(value));
  }
  return text;
}

export function translatedOrNull(instance, language, key) {
  if (language !== "en") return null;
  return instance.exists(key, { lng: "en" }) ? instance.t(key, { lng: "en" }) : null;
}

export function changeLanguage(instance, language) {
  return instance.changeLanguage(language === "en" ? "en" : "zh");
}

/**
 * Translate the static and pre-rendered DOM in place. Chinese remains the
 * migration-period source text, while optional `data-en*` attributes cover
 * copy that is assembled at runtime or contains markup.
 */
export function applyDomLanguage(root, instance, language) {
  if (!root) return;
  const document = root.ownerDocument || globalThis.document;
  if (!document) return;
  const view = document.defaultView || globalThis;
  const english = language === "en";
  const walker = document.createTreeWalker(
    root,
    view.NodeFilter.SHOW_TEXT | view.NodeFilter.SHOW_ELEMENT,
  );
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === 1) {
      if (node.dataset.en) {
        if (english && node.childNodes.length > 1) {
          if (!node.dataset.zhHtml) node.dataset.zhHtml = node.innerHTML;
          node.textContent = node.dataset.en;
        } else if (english && node.firstChild && node.firstChild.nodeType === 3) {
          const raw = node.firstChild.nodeValue;
          const lead = raw.match(/^\s*/)?.[0] || "";
          node.dataset.zhText = node.dataset.zhText || raw;
          node.firstChild.nodeValue = lead + node.dataset.en;
        } else if (!english && node.dataset.zhText != null
          && node.firstChild && node.firstChild.nodeType === 3) {
          node.firstChild.nodeValue = node.dataset.zhText;
        }
        if (!english) delete node.dataset.zhText;
      }
      if (node.dataset.enPh) {
        if (english) {
          node.dataset.zhPh = node.dataset.zhPh || node.placeholder;
          node.placeholder = node.dataset.enPh;
        } else if (node.dataset.zhPh != null) {
          node.placeholder = node.dataset.zhPh;
        }
        if (!english) delete node.dataset.zhPh;
      }
      if (node.dataset.enTitle) {
        if (english) {
          if (node.dataset.zhTip == null) {
            node.dataset.zhTip = node.dataset.tip || node.getAttribute("title") || "";
          }
          node.dataset.tip = node.dataset.enTitle;
          node.removeAttribute("title");
        } else if (node.dataset.zhTip) {
          node.dataset.tip = node.dataset.zhTip;
          delete node.dataset.zhTip;
        }
      }
      if (node.placeholder) {
        const placeholder = translatedOrNull(instance, language, node.placeholder)
          || translatedOrNull(instance, language, node.placeholder.trim().replace(/\s+/g, " "));
        if (english && placeholder) {
          node.dataset.zhPh = node.dataset.zhPh || node.placeholder;
          node.placeholder = placeholder;
        } else if (!english && node.dataset.zhPh) {
          node.placeholder = node.dataset.zhPh;
        }
      }
      const rawTip = node.dataset.tip || node.getAttribute("title");
      if (rawTip) {
        const tip = translatedOrNull(instance, language, rawTip)
          || translatedOrNull(instance, language, rawTip.trim().replace(/\s+/g, " "));
        if (english && tip) {
          node.dataset.zhTi = node.dataset.zhTi || rawTip;
          node.dataset.tip = tip;
        } else if (!english && node.dataset.zhTi) {
          node.dataset.tip = node.dataset.zhTi;
        }
      }
      continue;
    }
    const raw = (node.nodeValue || "").trim();
    if (!raw) continue;
    const key = raw.replace(/\s+/g, " ");
    if (english) {
      const translated = translatedOrNull(instance, language, raw)
        || translatedOrNull(instance, language, key);
      if (translated) {
        if (node.__zh == null) node.__zh = node.nodeValue;
        node.nodeValue = node.nodeValue.replace(raw, translated);
      }
    } else if (node.__zh != null) {
      node.nodeValue = node.__zh;
      node.__zh = null;
    }
  }
}

/** Runtime modules call this after rebuilding a pane with `data-en` markup. */
export function syncDataLanguage(root, language) {
  if (!root) return;
  const english = language === "en";
  for (const element of root.querySelectorAll("[data-en], [data-en-ph]")) {
    if (element.dataset.en && element.childNodes.length > 1) {
      if (english) {
        if (!element.dataset.zhHtml) element.dataset.zhHtml = element.innerHTML;
        element.textContent = element.dataset.en;
      } else if (element.dataset.zhHtml) {
        element.innerHTML = element.dataset.zhHtml;
        delete element.dataset.zhHtml;
      }
    } else if (element.dataset.en && element.firstChild && element.firstChild.nodeType === 3) {
      if (english) {
        const raw = element.firstChild.nodeValue;
        const lead = raw.match(/^\s*/)?.[0] || "";
        element.dataset.zhText = element.dataset.zhText || raw;
        element.firstChild.nodeValue = lead + element.dataset.en;
      } else if (element.dataset.zhText != null) {
        element.firstChild.nodeValue = element.dataset.zhText;
        delete element.dataset.zhText;
      }
    }
    if (element.dataset.enPh) {
      if (english) {
        element.dataset.zhPh = element.dataset.zhPh || element.placeholder;
        element.placeholder = element.dataset.enPh;
      } else if (element.dataset.zhPh != null) {
        element.placeholder = element.dataset.zhPh;
        delete element.dataset.zhPh;
      }
    }
  }
}
