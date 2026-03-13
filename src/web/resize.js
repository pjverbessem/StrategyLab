/**
 * resize.js — Drag-to-resize panel handles for Strategy Lab Creator
 *
 * Handles:
 *   col-resizer#resizer-col2  → adjusts --col1-w  (Chat column width)
 *   col-resizer#resizer-col3  → adjusts --col3-w  (Results column width)
 *   row-resizer#resizer-chart → adjusts --chart-h (Bottom chart height)
 *
 * CSS variables are set on :root and persisted to localStorage.
 */

(function () {
    'use strict';

    const MIN_COL = 160;   // px — minimum column width
    const MAX_COL = 700;   // px — maximum column width
    const MIN_ROW = 80;    // px — minimum row height
    const MAX_ROW = 700;   // px — maximum row height

    const root = document.documentElement;

    /* ── Utility ─────────────────────────────────────────────────── */
    function setVar(name, px) {
        root.style.setProperty(name, px + 'px');
    }

    function clamp(v, lo, hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    function save(key, px) {
        try { localStorage.setItem('sl-resize-' + key, Math.round(px)); } catch (_) { }
    }

    function load(key, fallback) {
        try {
            const v = parseInt(localStorage.getItem('sl-resize-' + key), 10);
            return isNaN(v) ? fallback : v;
        } catch (_) { return fallback; }
    }

    /* ── Restore saved sizes on boot ─────────────────────────────── */
    function restore() {
        setVar('--col1-w', clamp(load('col1', 320), MIN_COL, MAX_COL));
        setVar('--col3-w', clamp(load('col3', 340), MIN_COL, MAX_COL));
        setVar('--chart-h', clamp(load('chart', 240), MIN_ROW, MAX_ROW));
    }

    /* ── Column drag handler ──────────────────────────────────────── */
    /**
     * @param {string} handleId — id of .col-resizer element
     * @param {string} cssVar   — CSS variable to update
     * @param {string} saveKey  — localStorage key
     * @param {number} invert   — +1 or -1 (invert delta for right-side col)
     * @param {number} defW     — default width (for dblclick reset)
     */
    function attachColResizer(handleId, cssVar, saveKey, invert, defW) {
        const handle = document.getElementById(handleId);
        if (!handle) return;

        let startX = 0;
        let startW = 0;

        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startX = e.clientX;
            startW = parseInt(root.style.getPropertyValue(cssVar), 10) || defW;

            handle.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';

            const onMove = (ev) => {
                const delta = (ev.clientX - startX) * invert;
                setVar(cssVar, clamp(startW + delta, MIN_COL, MAX_COL));
            };

            const onUp = (ev) => {
                const delta = (ev.clientX - startX) * invert;
                const newW = clamp(startW + delta, MIN_COL, MAX_COL);
                setVar(cssVar, newW);
                save(saveKey, newW);
                handle.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        handle.addEventListener('dblclick', () => {
            setVar(cssVar, defW);
            save(saveKey, defW);
        });
    }

    /* ── Row drag handler ─────────────────────────────────────────── */
    /**
     * @param {string} handleId — id of .row-resizer element
     * @param {string} cssVar   — CSS variable to update
     * @param {string} saveKey  — localStorage key
     * @param {number} defH     — default height (for dblclick reset)
     */
    function attachRowResizer(handleId, cssVar, saveKey, defH) {
        const handle = document.getElementById(handleId);
        if (!handle) return;

        let startY = 0;
        let startH = 0;

        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startY = e.clientY;
            startH = parseInt(root.style.getPropertyValue(cssVar), 10) || defH;

            handle.classList.add('dragging');
            document.body.style.cursor = 'row-resize';
            document.body.style.userSelect = 'none';

            const onMove = (ev) => {
                /* Dragging up makes it taller */
                const delta = startY - ev.clientY;
                setVar(cssVar, clamp(startH + delta, MIN_ROW, MAX_ROW));
            };

            const onUp = (ev) => {
                const delta = startY - ev.clientY;
                const newH = clamp(startH + delta, MIN_ROW, MAX_ROW);
                setVar(cssVar, newH);
                save(saveKey, newH);
                handle.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        handle.addEventListener('dblclick', () => {
            setVar(cssVar, defH);
            save(saveKey, defH);
        });
    }

    /* ── Touch support helper ─────────────────────────────────────── */
    function addTouchSupport(el, cssVar, saveKey, isRow, invert) {
        let startPos = 0;
        let startVal = 0;

        el.addEventListener('touchstart', (e) => {
            const t = e.touches[0];
            startPos = isRow ? t.clientY : t.clientX;
            startVal = parseInt(root.style.getPropertyValue(cssVar), 10) || (isRow ? 240 : 320);
            el.classList.add('dragging');
        }, { passive: true });

        el.addEventListener('touchmove', (e) => {
            e.preventDefault();
            const t = e.touches[0];
            const pos = isRow ? t.clientY : t.clientX;
            const dir = isRow ? (startPos - pos) : (pos - startPos) * (invert || 1);
            const lo = isRow ? MIN_ROW : MIN_COL;
            const hi = isRow ? MAX_ROW : MAX_COL;
            setVar(cssVar, clamp(startVal + dir, lo, hi));
        }, { passive: false });

        el.addEventListener('touchend', () => {
            const v = parseInt(root.style.getPropertyValue(cssVar), 10);
            if (v) save(saveKey, v);
            el.classList.remove('dragging');
        });
    }

    /* ── Init ─────────────────────────────────────────────────────── */
    function init() {
        restore();

        /* resizer-col2: drag right/left to resize the Chat column (col1) */
        attachColResizer('resizer-col2', '--col1-w', 'col1', 1, 320);

        /* resizer-col3: drag right/left to resize the Results column (col3, inverted) */
        attachColResizer('resizer-col3', '--col3-w', 'col3', -1, 340);

        /* resizer-chart: drag up to make bottom chart taller */
        attachRowResizer('resizer-chart', '--chart-h', 'chart', 240);

        /* Touch */
        const r2 = document.getElementById('resizer-col2');
        const r3 = document.getElementById('resizer-col3');
        const rch = document.getElementById('resizer-chart');
        if (r2) addTouchSupport(r2, '--col1-w', 'col1', false, 1);
        if (r3) addTouchSupport(r3, '--col3-w', 'col3', false, -1);
        if (rch) addTouchSupport(rch, '--chart-h', 'chart', true, 1);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
