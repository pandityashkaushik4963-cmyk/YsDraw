/* =========================================================
   YsDraw - App.js
   ========================================================= */

// ---------- DOM references ----------
const canvas = document.getElementById('myCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true }); // we call getImageData often (undo / fill)
const previewCanvas = document.getElementById('previewCanvas');
const pctx = previewCanvas.getContext('2d');

const sizeSlider = document.getElementById('sizeSlider');
const sizeValue = document.getElementById('sizeValue');
const colorPicker = document.getElementById('colorPicker');
const colorButtons = document.querySelectorAll('.color');
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');

// Map every tool button id -> internal tool name
const toolButtons = {
    pencil: document.getElementById('pencil'),
    eraser: document.getElementById('eraser'),
    line: document.getElementById('lineTool'),
    rect: document.getElementById('rectTool'),
    oval: document.getElementById('ovalTool'),
    text: document.getElementById('textTool'),
    fill: document.getElementById('fillTool'),
};

// ---------- Constants & state ----------
const BG_COLOR = '#f2f2f2';   // canvas / eraser color (matches the CSS background)
const MAX_HISTORY = 15;       // max undo states kept in memory
const FILL_TOLERANCE = 32;    // how different (per channel) a pixel may be and still be filled (handles anti-aliased edges)

let currentTool = 'pencil';
let selectedColor = '#000000';
let brushSize = 5;

let isDrawing = false;
let startX = 0, startY = 0;   // where the current stroke/shape began
let lastX = 0, lastY = 0;     // previous point (for freehand lines)
let rafId = null;             // requestAnimationFrame handle for shape preview
let latestPos = null;         // latest pointer position waiting to be drawn in the preview

let history = [];             // stack of ImageData snapshots
let historyIndex = -1;        // pointer to the current state

let activeTextInput = null;   // the floating <input> used by the text tool

// ---------- Canvas setup ----------
function initCanvas() {
    canvas.width = previewCanvas.width = window.innerWidth;
    canvas.height = previewCanvas.height = window.innerHeight;
    paintBackground();
    applyStyle(ctx);
    saveState(); // initial blank state so the first stroke can be undone
}

// Fill the whole canvas with the background color (so eraser, fill and PNG export all agree)
function paintBackground() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// Apply current color / size / line style to a given context
function applyStyle(c) {
    c.lineWidth = brushSize;
    c.strokeStyle = currentTool === 'eraser' ? BG_COLOR : selectedColor; // eraser uses background color
    c.fillStyle = selectedColor;
    c.lineCap = 'round';
    c.lineJoin = 'round';
}

// Keep the canvas covering the window. It only ever GROWS, so drawings are never cropped
// (e.g. when a mobile keyboard opens for the text tool).
function resizeCanvas() {
    const newW = Math.max(canvas.width, window.innerWidth);
    const newH = Math.max(canvas.height, window.innerHeight);
    if (newW === canvas.width && newH === canvas.height) return;

    const temp = document.createElement('canvas'); // copy current drawing
    temp.width = canvas.width;
    temp.height = canvas.height;
    temp.getContext('2d').drawImage(canvas, 0, 0);

    canvas.width = previewCanvas.width = newW;      // resizing clears + resets the context
    canvas.height = previewCanvas.height = newH;
    paintBackground();
    ctx.drawImage(temp, 0, 0);
    applyStyle(ctx);
}
window.addEventListener('resize', resizeCanvas);

// ---------- Undo / Redo ----------
function saveState() {
    // If we undid something and then draw again, the "redo" future is discarded
    history = history.slice(0, historyIndex + 1);
    history.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (history.length > MAX_HISTORY) history.shift(); // drop the oldest state
    historyIndex = history.length - 1;
    updateHistoryButtons();
}

function undo() {
    if (historyIndex <= 0) return;
    historyIndex--;
    ctx.putImageData(history[historyIndex], 0, 0);
    updateHistoryButtons();
}

function redo() {
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    ctx.putImageData(history[historyIndex], 0, 0);
    updateHistoryButtons();
}

function updateHistoryButtons() {
    undoBtn.disabled = historyIndex <= 0;
    redoBtn.disabled = historyIndex >= history.length - 1;
}

// ---------- Tool / color selection ----------
function setTool(name) {
    commitText(); // finish any text being typed
    currentTool = name;
    Object.entries(toolButtons).forEach(([key, btn]) => btn.classList.toggle('active', key === name));
    canvas.style.cursor = name === 'text' ? 'text' : 'crosshair';
    applyStyle(ctx);
}

function setColor(hex) {
    selectedColor = hex;                 // pencil remembers this even after using the eraser
    colorPicker.value = hex;
    colorButtons.forEach(b => b.classList.toggle('active', b.dataset.color.toLowerCase() === hex.toLowerCase()));
    if (currentTool === 'eraser') setTool('pencil'); // picking a color implies you want to draw
    applyStyle(ctx);
}

Object.entries(toolButtons).forEach(([name, btn]) => btn.addEventListener('click', () => setTool(name)));

colorButtons.forEach(button => {
    button.addEventListener('click', () => setColor(button.dataset.color));
});

colorPicker.addEventListener('input', e => {
    colorButtons.forEach(b => b.classList.remove('active'));
    selectedColor = e.target.value;
    if (currentTool === 'eraser') setTool('pencil');
    applyStyle(ctx);
});

sizeSlider.addEventListener('input', e => {
    brushSize = Number(e.target.value);
    sizeValue.textContent = brushSize;
    ctx.lineWidth = brushSize;
});

undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);

document.getElementById('clr_Scr').addEventListener('click', () => {
    commitText();
    paintBackground();     // clearRect + repaint background
    applyStyle(ctx);
    saveState();
});

// Download the drawing as PNG (background is already painted, so it isn't transparent)
document.getElementById('saveBtn').addEventListener('click', () => {
    commitText();
    canvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'ysdraw.png';
        a.click();
        URL.revokeObjectURL(url);
    }, 'image/png');
});

// ---------- Pointer helpers (shared by mouse + touch) ----------
function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const p = e.touches ? (e.touches[0] || e.changedTouches[0]) : e;
    return { x: p.clientX - rect.left, y: p.clientY - rect.top };
}

// ---------- Shape drawing ----------
// Draws a line / rectangle / oval from (x1,y1) to (x2,y2) on any context
function drawShape(c, tool, x1, y1, x2, y2) {
    c.beginPath();
    if (tool === 'line') {
        c.moveTo(x1, y1);
        c.lineTo(x2, y2);
    } else if (tool === 'rect') {
        c.rect(x1, y1, x2 - x1, y2 - y1);
    } else if (tool === 'oval') {
        // ellipse inscribed in the dragged bounding box
        c.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
    }
    c.stroke();
}

// Shape PREVIEW: each frame we wipe the transparent preview canvas and redraw the shape there.
// The main canvas is untouched until mouseup, so there is no need to save/restore pixels.
// Drawing is throttled with requestAnimationFrame so it runs at most once per screen refresh.
function schedulePreview() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!isDrawing || !latestPos) return;
        pctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
        drawShape(pctx, currentTool, startX, startY, latestPos.x, latestPos.y);
    });
}

// ---------- Flood fill (bucket tool) ----------
// Scanline flood fill: instead of pushing every pixel on a stack, we fill whole horizontal
// "spans" at a time and only queue the spans directly above/below. Much faster than naive recursion.
function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function floodFill(sx, sy, hexColor) {
    sx = Math.floor(sx); sy = Math.floor(sy);
    const w = canvas.width, h = canvas.height;
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;

    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const [fr, fg, fb] = hexToRgb(hexColor);

    // The color we are replacing = color of the clicked pixel
    const s = (sy * w + sx) * 4;
    const tr = d[s], tg = d[s + 1], tb = d[s + 2];
    if (tr === fr && tg === fg && tb === fb) return; // already that color

    const visited = new Uint8Array(w * h);           // prevents revisiting pixels
    const match = i =>                               // does pixel i look like the target (within tolerance)?
        Math.abs(d[i] - tr) <= FILL_TOLERANCE &&
        Math.abs(d[i + 1] - tg) <= FILL_TOLERANCE &&
        Math.abs(d[i + 2] - tb) <= FILL_TOLERANCE;

    const stack = [sx, sy];
    while (stack.length) {
        const y = stack.pop();
        let x = stack.pop();
        let p = y * w + x;

        // 1) walk left to the start of this span
        while (x >= 0 && !visited[p] && match(p * 4)) { x--; p--; }
        x++; p++;

        // 2) walk right, painting pixels and queueing spans above and below
        let spanUp = false, spanDown = false;
        while (x < w && !visited[p] && match(p * 4)) {
            visited[p] = 1;
            const i = p * 4;
            d[i] = fr; d[i + 1] = fg; d[i + 2] = fb; d[i + 3] = 255;

            if (y > 0) {
                const up = p - w;
                const ok = !visited[up] && match(up * 4);
                if (ok && !spanUp) { stack.push(x, y - 1); spanUp = true; }
                else if (!ok) spanUp = false;
            }
            if (y < h - 1) {
                const down = p + w;
                const ok = !visited[down] && match(down * 4);
                if (ok && !spanDown) { stack.push(x, y + 1); spanDown = true; }
                else if (!ok) spanDown = false;
            }
            x++; p++;
        }
    }
    ctx.putImageData(img, 0, 0);
}

// ---------- Text tool ----------
function createTextInput(x, y) {
    commitText();
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-input';
    const fontSize = Math.max(14, brushSize * 2 + 10); // text size follows the size slider
    input.dataset.x = x;
    input.dataset.y = y;
    input.dataset.fontSize = fontSize;
    input.style.left = (x - 1) + 'px';
    input.style.top = (y - 1) + 'px';
    input.style.font = `${fontSize}px Poppins, sans-serif`;
    input.style.color = selectedColor;
    input.addEventListener('input', () => { input.style.width = (input.value.length + 2) + 'ch'; });
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') commitText();
        else if (e.key === 'Escape') { input.dataset.cancel = '1'; commitText(); }
        e.stopPropagation(); // don't trigger tool shortcuts while typing
    });
    input.addEventListener('blur', commitText);
    document.body.appendChild(input);
    activeTextInput = input;
    setTimeout(() => input.focus(), 0);
}

// Bake the typed text into the canvas and remove the input box
function commitText() {
    const input = activeTextInput;
    if (!input) return;
    activeTextInput = null; // clear first so the blur event triggered by remove() doesn't run this twice

    const text = input.value;
    const cancelled = input.dataset.cancel === '1';
    const x = Number(input.dataset.x), y = Number(input.dataset.y);
    const fontSize = input.dataset.fontSize;
    input.remove();

    if (cancelled || !text.trim()) return;
    ctx.fillStyle = selectedColor;
    ctx.font = `${fontSize}px Poppins, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(text, x, y);
    saveState();
}

// ---------- Drawing handlers (mouse + touch both end up here) ----------
function startDraw(e) {
    const { x, y } = getPos(e);

    if (currentTool === 'text') {
        e.preventDefault();      // stop the browser from stealing focus from the new input
        createTextInput(x, y);
        return;
    }

    if (currentTool === 'fill') {
        floodFill(x, y, selectedColor);
        saveState();
        return;
    }

    isDrawing = true;
    [startX, startY] = [x, y];
    [lastX, lastY] = [x, y];
    applyStyle(ctx);
    applyStyle(pctx);

    if (currentTool === 'pencil' || currentTool === 'eraser') {
        // zero-length line with round caps = a single dot on simple click
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y);
        ctx.stroke();
    }
}

function moveDraw(e) {
    if (!isDrawing) return;
    const { x, y } = getPos(e);

    if (currentTool === 'pencil' || currentTool === 'eraser') {
        // freehand: draw straight onto the main canvas segment by segment
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(x, y);
        ctx.stroke();
        [lastX, lastY] = [x, y];
    } else {
        latestPos = { x, y };   // shapes: only remember the position, preview is drawn in rAF
        schedulePreview();
    }
}

function endDraw(e) {
    if (!isDrawing) return;
    isDrawing = false;

    if (currentTool === 'line' || currentTool === 'rect' || currentTool === 'oval') {
        const { x, y } = getPos(e);
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        pctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height); // remove the preview
        drawShape(ctx, currentTool, startX, startY, x, y);               // bake final shape into the canvas
        latestPos = null;
    }
    saveState();
}

// Mouse
canvas.addEventListener('mousedown', startDraw);
window.addEventListener('mousemove', moveDraw);   // on window so strokes continue if the cursor leaves the canvas
window.addEventListener('mouseup', endDraw);

// Touch (mobile / tablet) - mapped to the same handlers.
// passive:false + preventDefault stops page scrolling and the emulated mouse events.
canvas.addEventListener('touchstart', e => { e.preventDefault(); startDraw(e); }, { passive: false });
canvas.addEventListener('touchmove', e => { e.preventDefault(); moveDraw(e); }, { passive: false });
canvas.addEventListener('touchend', e => { e.preventDefault(); endDraw(e); }, { passive: false });
canvas.addEventListener('touchcancel', e => { e.preventDefault(); endDraw(e); }, { passive: false });

// ---------- Keyboard shortcuts ----------
const shortcuts = { p: 'pencil', e: 'eraser', l: 'line', r: 'rect', o: 'oval', t: 'text', f: 'fill' };
window.addEventListener('keydown', e => {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === 'z') {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
    } else if ((e.ctrlKey || e.metaKey) && key === 'y') {
        e.preventDefault();
        redo();
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && shortcuts[key]) {
        setTool(shortcuts[key]);
    }
});

// ---------- Start ----------
initCanvas();
setColor(selectedColor);
updateHistoryButtons();
