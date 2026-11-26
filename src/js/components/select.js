// Global custom dropdown overlay for all <select> elements
// Replaces the unstylable native OS popup with an Antigravity-styled monochrome
// floating menu while preserving every <select>'s native value, options, optgroups,
// disabled state, and "change" event listeners.

let activeMenu = null;
let activeAnchor = null;

export function closeCustomMenu() {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
  if (activeAnchor) {
    activeAnchor.classList.remove("select-open");
    activeAnchor = null;
  }
}

function positionAndShowMenu(menu, anchorEl) {
  document.body.appendChild(menu);

  const rect = anchorEl.getBoundingClientRect();
  const minW = Math.max(rect.width, 132);
  menu.style.minWidth = `${Math.round(minW)}px`;

  const menuRect = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 5;

  let top = rect.bottom + gap;
  let openUp = false;
  const spaceBelow = vh - rect.bottom - gap - 10;
  const spaceAbove = rect.top - gap - 10;
  if (menuRect.height > spaceBelow && spaceAbove > spaceBelow) {
    openUp = true;
    const clampedH = Math.min(menuRect.height, Math.max(100, spaceAbove));
    if (menuRect.height > spaceAbove) {
      menu.style.maxHeight = `${Math.floor(clampedH)}px`;
    }
    top = Math.max(10, rect.top - gap - clampedH);
  } else if (menuRect.height > spaceBelow) {
    menu.style.maxHeight = `${Math.max(100, Math.floor(spaceBelow))}px`;
  }

  let left = rect.left;
  if (left + menuRect.width > vw - 10) {
    left = Math.max(10, rect.right - menuRect.width);
  }

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  if (openUp) menu.classList.add("open-up");

  activeMenu = menu;
  activeAnchor = anchorEl;
  anchorEl.classList.add("select-open");

  const selItem = menu.querySelector(".custom-select-opt.selected");
  if (selItem) selItem.scrollIntoView({ block: "nearest" });

  requestAnimationFrame(() => menu.classList.add("visible"));
}

export function openCustomMenu(anchorEl, options, selectedValue, onSelect) {
  if (!anchorEl || anchorEl.disabled) return;
  if (activeAnchor === anchorEl && activeMenu) {
    closeCustomMenu();
    return;
  }
  closeCustomMenu();

  const menu = document.createElement("div");
  menu.className = "custom-select-menu";
  menu.setAttribute("role", "listbox");

  for (const o of options) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "custom-select-opt";
    if (String(o.value) === String(selectedValue)) item.classList.add("selected");
    if (o.disabled) item.disabled = true;
    item.textContent = o.name;
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      if (o.disabled) return;
      closeCustomMenu();
      onSelect(o.value);
    });
    menu.appendChild(item);
  }

  positionAndShowMenu(menu, anchorEl);
}

function openMenuFor(selectEl) {
  if (selectEl.disabled) return;
  if (activeAnchor === selectEl && activeMenu) {
    closeCustomMenu();
    return;
  }
  closeCustomMenu();

  const menu = document.createElement("div");
  menu.className = "custom-select-menu";
  menu.setAttribute("role", "listbox");

  const addOptionItem = (opt) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "custom-select-opt";
    if (opt.value === selectEl.value) item.classList.add("selected");
    if (opt.disabled) item.disabled = true;
    item.textContent = opt.textContent;
    item.dataset.val = opt.value;
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      if (opt.disabled) return;
      const changed = selectEl.value !== opt.value;
      selectEl.value = opt.value;
      closeCustomMenu();
      if (changed) {
        selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    menu.appendChild(item);
  };

  for (const child of Array.from(selectEl.children)) {
    if (child.tagName === "OPTGROUP") {
      const grpLabel = document.createElement("div");
      grpLabel.className = "custom-select-group";
      grpLabel.textContent = child.label;
      menu.appendChild(grpLabel);
      for (const opt of Array.from(child.children)) {
        if (opt.tagName === "OPTION") addOptionItem(opt);
      }
    } else if (child.tagName === "OPTION") {
      addOptionItem(child);
    }
  }

  positionAndShowMenu(menu, selectEl);
}

export function initCustomSelects() {
  document.addEventListener(
    "mousedown",
    (e) => {
      const sel = e.target.closest?.("select");
      if (sel) {
        e.preventDefault();
        e.stopPropagation();
        openMenuFor(sel);
        return;
      }
      if (activeAnchor && activeAnchor.contains(e.target)) {
        return;
      }
      if (activeMenu && !activeMenu.contains(e.target)) {
        closeCustomMenu();
      }
    },
    true
  );

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && activeMenu) {
      e.preventDefault();
      closeCustomMenu();
      return;
    }
    const sel = document.activeElement?.tagName === "SELECT" ? document.activeElement : null;
    if (sel && (e.key === "Enter" || e.key === " " || e.key === "ArrowDown")) {
      e.preventDefault();
      openMenuFor(sel);
    }
  });

  window.addEventListener("blur", closeCustomMenu);
  window.addEventListener("resize", closeCustomMenu);
  document.addEventListener(
    "scroll",
    (e) => {
      if (activeMenu && e.target !== activeMenu) closeCustomMenu();
    },
    true
  );
}
