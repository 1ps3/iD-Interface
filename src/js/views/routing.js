// Output Routing Matrix (Analogue Outputs 1-4 & HP 1) + Loopback Router (Inputs 11+12)
// Includes the "This Could Be Loud!" confirmation guard when routing VIRTUAL THRU

import { pathKey } from "../store.js";

const OUT_SOURCES = [
  { value: 0, name: "MAIN" },
  { value: 1, name: "ALT" },
  { value: 2, name: "MIX A" },
  { value: 3, name: "MIX B" },
  { value: 4, name: "VIRTUAL THRU" },
];

const HP_SOURCES = [
  { value: 0, name: "MAIN" },
  { value: 1, name: "MIX A" },
  { value: 2, name: "MIX B" },
  { value: 3, name: "VIRTUAL THRU" },
];

const LB_SOURCES = [
  { value: 0, name: "MAIN MIX" },
  { value: 1, name: "MIX A" },
  { value: 2, name: "MIX B" },
  { value: 3, name: "VIRTUAL THRU" },
];

const LB_VIRT_OUTS = [
  { value: 0, name: "VIRTUAL OUTS 1 + 2" },
  { value: 1, name: "VIRTUAL OUTS 3 + 4" },
  { value: 2, name: "VIRTUAL OUTS 5 + 6" },
  { value: 3, name: "VIRTUAL OUTS 7 + 8" },
];

export function createRoutingView(container, store) {
  let pendingLoudAction = null;
  let paramBindings = new Map();
  let linkPaths = new Set();

  container.innerHTML = `
    <div class="view-header">
      <div>
        <h2 class="view-title">OUTPUT ROUTING</h2>
        <p class="view-subtitle">Route internal mixes &amp; virtual computer audio to physical outputs and Loopback</p>
      </div>
    </div>

    <div class="routing-body" id="routingBody"></div>

    <!-- "This Could Be Loud!" Safety Modal -->
    <div class="modal-backdrop" id="loudModal" style="display:none;">
      <div class="modal-card">
        <div class="modal-icon">!</div>
        <h3>This Could Be Loud!</h3>
        <p>'VIRTUAL THRU' routes the output from your computer directly to the outputs without any volume control. This could be loud!</p>
        <div class="modal-actions">
          <button class="action-btn" id="btnLoudCancel">CANCEL</button>
          <button class="action-btn danger-btn" id="btnLoudConfirm">CONFIRM</button>
        </div>
      </div>
    </div>
  `;

  const bodyEl = container.querySelector("#routingBody");
  const loudModal = container.querySelector("#loudModal");

  container.querySelector("#btnLoudCancel").addEventListener("click", () => {
    pendingLoudAction = null;
    loudModal.style.display = "none";
  });

  container.querySelector("#btnLoudConfirm").addEventListener("click", () => {
    const fn = pendingLoudAction;
    pendingLoudAction = null;
    loudModal.style.display = "none";
    if (fn) fn();
  });

  function confirmVirtualThru(actionFn) {
    pendingLoudAction = actionFn;
    loudModal.style.display = "flex";
  }

  function bind(path, fn) {
    if (!path) return;
    const k = pathKey(path);
    if (!paramBindings.has(k)) paramBindings.set(k, []);
    paramBindings.get(k).push(fn);
  }

  function renderOutputsAndLoopback() {
    const outRouter = store.paths.outputRouter;
    if (!outRouter) {
      bodyEl.innerHTML = `<div class="phase-placeholder"><span class="phase-tag">ROUTING</span><h3>Connecting to device…</h3></div>`;
      return;
    }

    const outRouterNode = store.getNode(outRouter);
    const pairEntries = [];
    if (outRouterNode?.children) {
      outRouterNode.children.forEach((child, idx) => {
        if (child.tag !== "Pair") return;
        const pairPath = [...outRouter, idx];
        const pIdx = typeof child.props?.index === "number" ? child.props.index : pairEntries.length;
        const linkPath = store.findParamPath(pairPath, "StereoLink");
        const trimPath = store.findParamPath(pairPath, "Trim");
        if (linkPath) linkPaths.add(pathKey(linkPath));
        const ch0 = store.findChildPath(pairPath, (c) => c.tag === "Channel" && c.props?.index === 0);
        const ch1 = store.findChildPath(pairPath, (c) => c.tag === "Channel" && c.props?.index === 1);
        pairEntries.push({
          pIdx,
          linkPath,
          trimPath,
          isStereo: Boolean(store.getVal(linkPath, 1)),
          src0: ch0 ? store.findParamPath(ch0, "Src") : null,
          src1: ch1 ? store.findParamPath(ch1, "Src") : null,
        });
      });
    }
    pairEntries.sort((a, b) => a.pIdx - b.pIdx);

    const altTrim = pairEntries.find((e) => e.trimPath)?.trimPath || null;

    // Dynamically find all headphone channels (HP1, HP2, etc.) under MonitorControl
    const hpEntries = [];
    if (store.paths.monitorControl) {
      const mcNode = store.getNode(store.paths.monitorControl);
      mcNode?.children?.forEach((c, idx) => {
        if (c.tag === "Channel" && /^HP\d+/i.test(c.props?.name || "")) {
          const hpPath = [...store.paths.monitorControl, idx];
          const srcPath = store.findParamPath(hpPath, "Src");
          if (srcPath) {
            const label = (c.props.name || "HP").replace(/^HP(\d+)/i, "HP $1");
            hpEntries.push({ label, srcPath });
          }
        }
      });
    }
    if (hpEntries.length === 0 && store.paths.hp1Src) {
      hpEntries.push({ label: "HP 1", srcPath: store.paths.hp1Src });
    }

    bodyEl.innerHTML = `
      <div class="routing-card">
        <div class="routing-matrix-head">
          <span class="rm-col-out">OUTPUTS</span>
          <span class="rm-col-src">MAIN</span>
          <span class="rm-col-src">ALT</span>
          <span class="rm-col-src">MIX A</span>
          <span class="rm-col-src">MIX B</span>
          <span class="rm-col-src">VIRTUAL THRU</span>
        </div>
        <div class="routing-matrix-rows" id="matrixRows"></div>

        ${altTrim ? `
        <div class="alt-trim-bar">
          <span class="micro-label">ALT SPEAKER TRIM (OUT 3–4)</span>
          <input type="range" class="mini-slider" id="altTrimSlider" min="-128" max="0" step="0.5" />
          <span class="comp-val" id="altTrimVal">0.0 dB</span>
        </div>` : ""}
      </div>

      <div class="routing-card outputs-trim-card">
        <div class="dock-header">
          <span class="dock-title">PHYSICAL OUTPUT TRIM &amp; MUTE</span>
        </div>
        <div class="phys-out-grid" id="physOutGrid"></div>
      </div>

      <div class="routing-card loopback-card" id="loopbackCard"></div>
    `;

    const rowsEl = bodyEl.querySelector("#matrixRows");

    function addMatrixRow({ label, linkPath, isStereo, paths, pairPaths = null, sources, isHp = false }) {
      const row = document.createElement("div");
      row.className = "routing-row";

      const leftCell = document.createElement("div");
      leftCell.className = "rm-col-out";
      if (linkPath) {
        const lBtn = document.createElement("button");
        lBtn.className = `mini-pill-btn ${isStereo ? "active" : ""}`;
        lBtn.textContent = isStereo ? "STEREO" : "MONO";
        lBtn.addEventListener("click", () => {
          const next = isStereo ? 0 : 1;
          store.setParam(linkPath, next);
          // When linking MONO -> STEREO, sync the right output channel to match the left so hardware never stays split
          const syncPair = pairPaths || paths;
          if (next === 1 && syncPair.length >= 2 && syncPair[0] && syncPair[1]) {
            const leftVal = store.getVal(syncPair[0], 0);
            if (store.getVal(syncPair[1], 0) !== leftVal) {
              store.setParam(syncPair[1], leftVal);
            }
          }
        });
        leftCell.appendChild(lBtn);
      }
      const lbl = document.createElement("span");
      lbl.className = "rm-out-label";
      lbl.textContent = label;
      leftCell.appendChild(lbl);
      row.appendChild(leftCell);

      const dotButtons = [];
      for (const colSrc of OUT_SOURCES) {
        const cell = document.createElement("div");
        cell.className = "rm-col-src";

        // HP1 has no ALT option (its values are 0=MAIN, 1=MIX A, 2=MIX B, 3=VIRTUAL THRU)
        const matchingSrc = isHp
          ? HP_SOURCES.find((s) => s.name === colSrc.name)
          : colSrc;

        if (!matchingSrc) {
          cell.innerHTML = `<span class="rm-na">—</span>`;
        } else {
          const dot = document.createElement("button");
          dot.className = "rm-dot";
          dot.title = `${label} → ${matchingSrc.name}`;
          dot.dataset.val = String(matchingSrc.value);
          dot.addEventListener("click", () => {
            const apply = () => {
              paths.forEach((p) => p && store.setParam(p, matchingSrc.value));
            };
            if (matchingSrc.name === "VIRTUAL THRU") {
              confirmVirtualThru(apply);
            } else {
              apply();
            }
          });
          cell.appendChild(dot);
          dotButtons.push(dot);
        }
        row.appendChild(cell);
      }

      const syncRow = () => {
        const cur = store.getVal(paths[0], 0);
        dotButtons.forEach((d) => d.classList.toggle("active", Number(d.dataset.val) === cur));
      };
      paths.forEach((p) => bind(p, syncRow));
      syncRow();

      rowsEl.appendChild(row);
    }

    pairEntries.forEach((pe, idx) => {
      const chA = idx * 2 + 1;
      const chB = idx * 2 + 2;
      if (pe.isStereo) {
        addMatrixRow({ label: `OUT ${chA} + ${chB}`, linkPath: pe.linkPath, isStereo: true, paths: [pe.src0, pe.src1], sources: OUT_SOURCES });
      } else {
        addMatrixRow({ label: `OUT ${chA}`, linkPath: pe.linkPath, isStereo: false, paths: [pe.src0], pairPaths: [pe.src0, pe.src1], sources: OUT_SOURCES });
        addMatrixRow({ label: `OUT ${chB}`, linkPath: null, isStereo: false, paths: [pe.src1], sources: OUT_SOURCES });
      }
    });

    hpEntries.forEach((hp) => {
      addMatrixRow({ label: hp.label, linkPath: null, isStereo: true, paths: [hp.srcPath], sources: HP_SOURCES, isHp: true });
    });

    if (altTrim) {
      const sl = bodyEl.querySelector("#altTrimSlider");
      const vl = bodyEl.querySelector("#altTrimVal");
      const syncTrim = () => {
        const v = Number(store.getVal(altTrim, 0));
        sl.value = String(v);
        vl.textContent = v <= -128 ? "-∞ dB" : `${v.toFixed(1)} dB`;
      };
      sl.addEventListener("input", () => store.setParam(altTrim, Number(sl.value)));
      bind(altTrim, syncTrim);
      syncTrim();
    }

    // Physical Outputs L1..R4 trims & mutes
    const physGrid = bodyEl.querySelector("#physOutGrid");
    const outputsPath = store.paths.outputs;
    const outNode = store.getNode(outputsPath);
    if (outNode?.children) {
      outNode.children.forEach((c, idx) => {
        const chPath = [...outputsPath, idx];
        const vPath = store.findParamPath(chPath, "Vol");
        const mPath = store.findParamPath(chPath, "Mute");
        const item = document.createElement("div");
        item.className = "phys-out-item";
        item.innerHTML = `
          <div class="phys-out-top">
            <span class="micro-label">${c.props?.name || `OUT ${idx + 1}`}</span>
            <button class="ms-btn mute-btn" id="pMute">MUTE</button>
          </div>
          <div class="phys-out-sl">
            <input type="range" class="mini-slider" id="pVol" min="-128" max="0" step="1" />
            <span class="comp-val" id="pVal">0 dB</span>
          </div>
        `;
        physGrid.appendChild(item);

        const btnM = item.querySelector("#pMute");
        const slV = item.querySelector("#pVol");
        const lblV = item.querySelector("#pVal");
        const syncOut = () => {
          btnM.classList.toggle("active", Boolean(store.getVal(mPath, 0)));
          const v = Number(store.getVal(vPath, 0));
          slV.value = String(Math.round(v));
          lblV.textContent = v <= -128 ? "-∞" : `${Math.round(v)} dB`;
        };
        btnM.addEventListener("click", () => store.toggleParam(mPath));
        slV.addEventListener("input", () => store.setParam(vPath, Number(slV.value)));
        bind(mPath, syncOut);
        bind(vPath, syncOut);
        syncOut();
      });
    }

    renderLoopbackSection(bodyEl.querySelector("#loopbackCard"));
  }

  function renderLoopbackSection(cardEl) {
    const lbRouter = store.paths.loopbackRouter;
    if (!cardEl || !lbRouter) {
      if (cardEl) cardEl.style.display = "none";
      return;
    }

    const chPath = store.findChildPath(lbRouter, (c) => c.tag === "Channel");
    const srcPath = chPath ? store.findParamPath(chPath, "Src") : null;
    const virtPath = chPath ? store.findParamPath(chPath, "VirtOut") : null;

    const topo = store.getDeviceTopology();
    const lbA = topo.analogCount + topo.digitalCount + 1;
    const lbB = lbA + 1;

    cardEl.innerHTML = `
      <div class="lb-head-bar">
        <div class="lb-head-text">
          <span class="dock-title">LOOPBACK — INPUTS ${lbA} + ${lbB}</span>
          <span class="lb-sub-inline">Route internal computer playback alongside live inputs in OBS, Zoom, or your DAW</span>
        </div>
        <div class="lb-virt-inline">
          <span class="micro-label">VIRTUAL THRU PAIR</span>
          <select class="dock-select lb-select" id="lbVirtSelect"></select>
        </div>
      </div>
      <div class="lb-sources-grid" id="lbSources"></div>
    `;

    const srcGrid = cardEl.querySelector("#lbSources");
    const virtSel = cardEl.querySelector("#lbVirtSelect");

    LB_VIRT_OUTS.forEach((o) => {
      const opt = document.createElement("option");
      opt.value = String(o.value);
      opt.textContent = o.name;
      virtSel.appendChild(opt);
    });

    const btns = LB_SOURCES.map((s) => {
      const btn = document.createElement("button");
      btn.className = "lb-src-btn";
      btn.dataset.val = String(s.value);
      btn.innerHTML = `<span class="rm-dot-indicator"></span><span>${s.name}</span>`;
      btn.addEventListener("click", () => store.setParam(srcPath, s.value));
      srcGrid.appendChild(btn);
      return btn;
    });

    virtSel.addEventListener("change", () => store.setParam(virtPath, Number(virtSel.value)));

    const syncLb = () => {
      const curSrc = store.getVal(srcPath, 0);
      btns.forEach((b) => b.classList.toggle("active", Number(b.dataset.val) === curSrc));
      virtSel.value = String(store.getVal(virtPath, 0));
      virtSel.disabled = curSrc !== 3; // Only active when VIRTUAL THRU is chosen
    };

    bind(srcPath, syncLb);
    bind(virtPath, syncLb);
    syncLb();
  }

  function rebuild() {
    paramBindings.clear();
    linkPaths.clear();
    bodyEl.innerHTML = "";
    renderOutputsAndLoopback();
  }

  store.onSnapshot(rebuild);
  store.onParam((changedPath, prop, value) => {
    const k = pathKey(changedPath);
    if (linkPaths.has(k)) {
      rebuild();
      return;
    }
    const cbs = paramBindings.get(k);
    if (cbs) cbs.forEach((fn) => fn(value));
  });

  rebuild();
}
