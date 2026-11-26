// Reusable monochrome SVG rotary knob component
// Supports:
// - Standard unipolar knobs (Volume -128..0, Gain 0..75, Trim 0..15, etc.)
// - Bipolar center-zero knobs (Pan -64..64, EQ Gain -12..12)
// - Circular inner hit target (never triggers window resize cursor)
// - Vertical drag (Shift for fine) + hover scroll wheel (Shift for fine)
// - Smooth decimal display while adjusting, snaps to whole number when settled

const SVG_NS = "http://www.w3.org/2000/svg";
let knobUidCounter = 0;

function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180.0;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx, cy, r, startAngle, endAngle) {
  if (Math.abs(endAngle - startAngle) < 0.2) return "";
  const a0 = Math.min(startAngle, endAngle);
  const a1 = Math.max(startAngle, endAngle);
  const start = polarToCartesian(cx, cy, r, a0);
  const end = polarToCartesian(cx, cy, r, a1);
  const largeArc = a1 - a0 <= 180 ? "0" : "1";
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

export function createKnob(container, opts = {}) {
  const min = opts.min ?? -128;
  const max = opts.max ?? 0;
  const centerZero = opts.centerZero ?? false;
  const muteAtMin = opts.muteAtMin ?? (!centerZero && min <= -120);
  const unit = opts.unit ?? "dB";
  const showUnit = opts.showUnit ?? true;
  const muteSubLabel = opts.muteSubLabel ?? `${min} dB`;
  const defaultValue = opts.defaultValue ?? (centerZero ? 0 : -35);
  const sensitivity = opts.sensitivity ?? (max - min) / 240;
  const fineSensitivity = opts.fineSensitivity ?? sensitivity * 0.2;
  const wheelStep = opts.wheelStep ?? 1;
  const fineWheelStep = opts.fineWheelStep ?? 0.5;
  const roundOnSettle = opts.roundOnSettle ?? true;
  const decimals = opts.decimals ?? (roundOnSettle ? 0 : 1);
  const compact = opts.compact ?? false;
  const showTicks = opts.showTicks ?? true;
  const logScale = opts.logScale ?? false;
  const steps = Array.isArray(opts.steps) && opts.steps.length > 1 ? opts.steps : null;
  const formatValue = opts.formatValue ?? null;
  const onChange = opts.onChange ?? (() => {});

  function nearestStepIndex(val) {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < steps.length; i++) {
      const d = Math.abs(steps[i] - val);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }

  function snapValue(val) {
    if (steps) return steps[nearestStepIndex(val)];
    return Math.max(min, Math.min(max, val));
  }

  const START_ANGLE = -135;
  const SWEEP_ANGLE = 270;
  const ZERO_ANGLE = START_ANGLE + ((0 - min) / (max - min)) * SWEEP_ANGLE;

  const trackRadius = showTicks ? 78 : 83;
  const bodyRadius = showTicks ? 63 : 67;
  const bevelRadius = showTicks ? 57 : 61;
  const ptrY1 = showTicks ? 40 : 36;
  const ptrY2 = showTicks ? 53 : 50;
  const hitRadius = showTicks ? 68 : 72;
  const gradId = `tiGrad_${++knobUidCounter}`;

  let currentVal = defaultValue;
  let lastActiveVal = defaultValue > min ? defaultValue : -35;
  let isDragging = false;
  let isScrolling = false;
  let scrollSettleTimer = null;
  let dragStartY = 0;
  let dragStartVal = defaultValue;
  let dragStartNorm = 0;
  let muted = false;
  let disabled = false;
  let faded = false;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 200 200");
  const baseClass = opts.svgClass || (compact ? "knob-svg knob-compact" : "knob-svg");
  svg.setAttribute("class", showTicks ? baseClass : `${baseClass} knob-no-ticks`);

  const valueSize = compact ? 36 : 28;

  let ticksMarkup = "";
  if (showTicks) {
    let lines = "";
    const tickCount = steps ? steps.length : 11;
    for (let i = 0; i < tickCount; i++) {
      const deg = START_ANGLE + (i / (tickCount - 1)) * SWEEP_ANGLE;
      const isMid = !steps && i === 5;
      const isEnd = i === 0 || i === tickCount - 1;
      const p1 = polarToCartesian(100, 100, 88, deg);
      const p2 = polarToCartesian(100, 100, steps || isMid || isEnd ? 96 : 93, deg);
      const cls = steps
        ? "dial-tick dial-tick-end"
        : isMid
          ? "dial-tick dial-tick-mid"
          : isEnd
            ? "dial-tick dial-tick-end"
            : "dial-tick dial-tick-minor";
      lines += `<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" class="${cls}" />`;
    }
    ticksMarkup = `<g class="dial-ticks">${lines}</g>`;
  }

  svg.innerHTML = `
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" style="stop-color:var(--dial-top, #303038)" />
        <stop offset="50%" style="stop-color:var(--dial-mid, #1d1d23)" />
        <stop offset="100%" style="stop-color:var(--dial-bot, #131317)" />
      </linearGradient>
    </defs>
    ${ticksMarkup}
    <path class="track-bg" />
    <path class="track-active" />
    <circle cx="100" cy="100" r="${bodyRadius}" fill="url(#${gradId})" class="dial-body" />
    <circle cx="100" cy="100" r="${bevelRadius}" class="dial-bevel" />
    <g class="dial-rotor">
      <line x1="100" y1="${ptrY1}" x2="100" y2="${ptrY2}" class="pointer" />
    </g>
    <text x="100" y="100" dy="0.35em" text-anchor="middle" class="db-value" style="font-size:${valueSize}px"><tspan class="val-sign"></tspan><tspan class="val-body">0</tspan><tspan class="val-pad" fill-opacity="0" aria-hidden="true"></tspan></text>
    <circle cx="100" cy="100" r="${hitRadius}" class="knob-hit" />
  `;

  container.appendChild(svg);

  const trackBg = svg.querySelector(".track-bg");
  const trackActive = svg.querySelector(".track-active");
  const dialRotor = svg.querySelector(".dial-rotor");
  const valueText = svg.querySelector(".db-value");
  const signSpan = valueText.querySelector(".val-sign");
  const bodySpan = valueText.querySelector(".val-body");
  const padSpan = valueText.querySelector(".val-pad");
  const unitText = svg.querySelector(".db-unit");
  const knobHit = svg.querySelector(".knob-hit");

  // Visually center the numeric digits by balancing any leading '-' or '+' with an invisible matching pad
  function setCenteredLabel(str) {
    const s = String(str);
    if (s.length > 1 && (s[0] === "-" || s[0] === "+")) {
      signSpan.textContent = s[0];
      bodySpan.textContent = s.slice(1);
      padSpan.textContent = s[0];
    } else {
      signSpan.textContent = "";
      bodySpan.textContent = s;
      padSpan.textContent = "";
    }
  }

  trackBg.setAttribute("d", describeArc(100, 100, trackRadius, START_ANGLE, START_ANGLE + SWEEP_ANGLE));

  function toNorm(val) {
    if (steps) {
      return nearestStepIndex(val) / (steps.length - 1);
    }
    if (val <= min) return 0;
    if (val >= max) return 1;
    if (logScale && min > 0) {
      return Math.log(val / min) / Math.log(max / min);
    }
    return (val - min) / (max - min);
  }

  function fromNorm(norm) {
    const n = Math.max(0, Math.min(1, norm));
    if (steps) {
      const idx = Math.round(n * (steps.length - 1));
      return steps[Math.max(0, Math.min(steps.length - 1, idx))];
    }
    if (logScale && min > 0) {
      return min * Math.pow(max / min, n);
    }
    return min + n * (max - min);
  }

  function formatDisplay(val, showDecimal) {
    const clean = val === 0 ? 0 : val;
    if (formatValue) return formatValue(clean, showDecimal);
    if (showDecimal) {
      const s = clean.toFixed(1);
      return s.endsWith(".0") ? s.slice(0, -2) : s;
    }
    if (decimals > 0) return clean.toFixed(decimals);
    return String(Math.round(clean));
  }

  function render(val, showDecimal = false) {
    const clamped = snapValue(val);
    const effective = steps ? clamped : showDecimal || !roundOnSettle ? clamped : Math.round(clamped);
    const clean = effective === 0 ? 0 : effective;
    currentVal = clean;
    if (!muteAtMin || clean > min) {
      lastActiveVal = steps ? clean : roundOnSettle ? Math.round(clean) : clean;
    }

    const norm = toNorm(clean);
    const angle = START_ANGLE + norm * SWEEP_ANGLE;
    const arcFrom = centerZero ? ZERO_ANGLE : START_ANGLE;
    trackActive.setAttribute("d", describeArc(100, 100, trackRadius, arcFrom, angle));
    dialRotor.setAttribute("transform", `rotate(${angle} 100 100)`);
    trackActive.classList.toggle("muted", muted);
    svg.classList.toggle("disabled", disabled);
    svg.classList.toggle("faded", faded);

    if (muteAtMin && clean <= min) {
      setCenteredLabel("MUTE");
      if (unitText) unitText.textContent = muteSubLabel;
    } else if (muted) {
      setCenteredLabel("MUTE");
      if (unitText) unitText.textContent = `${formatDisplay(clean, false)} ${unit}`;
    } else {
      setCenteredLabel(formatDisplay(clean, showDecimal));
      if (unitText) unitText.textContent = unit;
    }
  }

  function push(val, settle = false) {
    if (disabled) return;
    if (steps) {
      const snapped = snapValue(val);
      if (snapped === currentVal && !settle) return;
      render(snapped, false);
      onChange(snapped, settle);
      return;
    }
    const clamped = Math.max(min, Math.min(max, val));
    const displayQuant =
      settle && roundOnSettle
        ? Math.round(clamped)
        : Math.round(clamped * 10) / 10;
    const displayTarget = displayQuant === 0 ? 0 : displayQuant;
    render(displayTarget, !settle && roundOnSettle);
    const hwVal = roundOnSettle ? Math.round(clamped) : displayTarget;
    onChange(hwVal === 0 ? 0 : hwVal, settle);
  }

  knobHit.addEventListener("mousedown", (e) => e.stopPropagation());

  knobHit.addEventListener("pointerdown", (e) => {
    if (disabled) return;
    e.stopPropagation();
    clearTimeout(scrollSettleTimer);
    scrollSettleTimer = null;
    isScrolling = false;
    isDragging = true;
    knobHit.classList.add("dragging");
    dragStartY = e.clientY;
    dragStartVal = currentVal;
    dragStartNorm = toNorm(currentVal);
    knobHit.setPointerCapture(e.pointerId);
  });

  knobHit.addEventListener("pointermove", (e) => {
    if (!isDragging || disabled) return;
    const deltaY = dragStartY - e.clientY;
    if (steps) {
      const startIdx = nearestStepIndex(dragStartVal);
      const pxPerStep = e.shiftKey ? 52 : 30;
      const nextIdx = Math.max(0, Math.min(steps.length - 1, Math.round(startIdx + deltaY / pxPerStep)));
      push(steps[nextIdx], false);
    } else if (logScale && min > 0) {
      const normSens = e.shiftKey ? 0.0012 : 0.0045;
      push(fromNorm(dragStartNorm + deltaY * normSens), false);
    } else {
      const sens = e.shiftKey ? fineSensitivity : sensitivity;
      push(dragStartVal + deltaY * sens, false);
    }
  });

  function finishDrag(e) {
    if (!isDragging) return;
    isDragging = false;
    knobHit.classList.remove("dragging");
    if (knobHit.hasPointerCapture(e.pointerId)) {
      knobHit.releasePointerCapture(e.pointerId);
    }
    push(currentVal, true);
  }

  knobHit.addEventListener("pointerup", finishDrag);
  knobHit.addEventListener("pointercancel", finishDrag);

  knobHit.addEventListener(
    "wheel",
    (e) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();
      isScrolling = true;
      const dir = e.deltaY < 0 ? 1 : -1;
      if (steps) {
        const idx = nearestStepIndex(currentVal);
        const nextIdx = Math.max(0, Math.min(steps.length - 1, idx + dir));
        push(steps[nextIdx], false);
      } else if (logScale && min > 0) {
        const normStep = e.shiftKey ? 0.01 : 0.03;
        push(fromNorm(toNorm(currentVal) + dir * normStep), false);
      } else {
        const step = e.shiftKey ? fineWheelStep : wheelStep;
        push(currentVal + dir * step, false);
      }

      clearTimeout(scrollSettleTimer);
      scrollSettleTimer = setTimeout(() => {
        scrollSettleTimer = null;
        isScrolling = false;
        if (!isDragging) {
          push(currentVal, true);
        }
      }, 250);
    },
    { passive: false }
  );

  knobHit.addEventListener("dblclick", (e) => {
    if (disabled) return;
    e.stopPropagation();
    clearTimeout(scrollSettleTimer);
    scrollSettleTimer = null;
    isScrolling = false;
    if (muteAtMin) {
      if (currentVal <= min) {
        push(lastActiveVal > min ? lastActiveVal : defaultValue, true);
      } else {
        push(min, true);
      }
    } else {
      push(defaultValue, true);
    }
  });

  render(defaultValue, false);

  return {
    setValue(val) {
      if (!isDragging && !isScrolling && typeof val === "number" && Number.isFinite(val)) {
        render(val, false);
      }
    },
    setMuted(isMuted) {
      muted = Boolean(isMuted);
      render(currentVal, isDragging || isScrolling);
    },
    setDisabled(isDisabled) {
      disabled = Boolean(isDisabled);
      render(currentVal, false);
    },
    setFaded(isFaded) {
      faded = Boolean(isFaded);
      svg.classList.toggle("faded", faded);
    },
    isInteracting() {
      return isDragging || isScrolling;
    },
    el: svg,
  };
}
