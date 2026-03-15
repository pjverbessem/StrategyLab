/**
 * resize.js — Drag-to-resize handles for the 2×2 Strategy Lab grid
 *
 *  Resizers:
 *    col-resizer#resizer-col       → resize left vs right column
 *    row-resizer#resizer-left-row  → resize chat (top-left) vs code (bottom-left)
 *    row-resizer#resizer-right-row → resize chart (top-right) vs results (bottom-right)
 *
 *  Default layout is 50/50 everywhere (via CSS flex).
 *  When the user drags a handle, pixel sizes are saved to localStorage.
 */

(function () {
    'use strict';

    const MIN_PX = 120;   // minimum panel size in px
    const MAX_PX = 2000;  // generous max

    /* ── Utilities ────────────────────────────────────────────────── */
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const save = (k, v) => { try { localStorage.setItem('sl-' + k, Math.round(v)); } catch (_) { } };
    const load = (k) => { try { const v = parseInt(localStorage.getItem('sl-' + k), 10); return isNaN(v) ? null : v; } catch (_) { return null; } };

    /* ── Restore saved sizes (only if user previously resized) ────── */
    function restore() {
        // Column split
        const leftEl = document.querySelector('.grid-left');
        const lw = load('left-w');
        if (lw !== null && leftEl) {
            leftEl.style.flex = '0 0 ' + clamp(lw, MIN_PX, MAX_PX) + 'px';
        }
        // else: CSS flex: 35 default applies (≈35% width)

        // Left row split: chat height
        const chatEl = document.querySelector('.panel-chat');
        const ch = load('chat-h');
        if (ch !== null && chatEl) {
            chatEl.style.height = clamp(ch, MIN_PX, MAX_PX) + 'px';
            chatEl.style.flexShrink = '0';
        }

        // Right row split: chart height
        const chartEl = document.querySelector('.panel-chart');
        const crh = load('chart-h');
        if (crh !== null && chartEl) {
            chartEl.style.height = clamp(crh, MIN_PX, MAX_PX) + 'px';
            chartEl.style.flexShrink = '0';
        }
    }

    /* ── Column resizer (splits left ↔ right) ─────────────────────── */
    function attachColResizer(handleId) {
        const handle = document.getElementById(handleId);
        if (!handle) return;

        handle.addEventListener('mousedown', e => {
            e.preventDefault();
            const leftEl = document.querySelector('.grid-left');
            if (!leftEl) return;

            const startX = e.clientX;
            const startW = leftEl.getBoundingClientRect().width;

            handle.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';

            const move = ev => {
                const w = clamp(startW + (ev.clientX - startX), MIN_PX, MAX_PX);
                leftEl.style.flex = '0 0 ' + w + 'px';
            };

            const up = ev => {
                const w = clamp(startW + (ev.clientX - startX), MIN_PX, MAX_PX);
                leftEl.style.flex = '0 0 ' + w + 'px';
                save('left-w', w);
                handle.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', up);
            };

            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
        });

        // Double-click to reset to equal (remove override)
        handle.addEventListener('dblclick', () => {
            const leftEl = document.querySelector('.grid-left');
            if (leftEl) { leftEl.style.flex = '1'; }
            try { localStorage.removeItem('sl-left-w'); } catch (_) { }
        });
    }

    /* ── Row resizer (splits top ↔ bottom within a column) ─────────── */
    function attachRowResizer(handleId, topSelector, saveKey) {
        const handle = document.getElementById(handleId);
        if (!handle) return;

        handle.addEventListener('mousedown', e => {
            e.preventDefault();
            const topEl = document.querySelector(topSelector);
            if (!topEl) return;

            const startY = e.clientY;
            const startH = topEl.getBoundingClientRect().height;

            handle.classList.add('dragging');
            document.body.style.cursor = 'row-resize';
            document.body.style.userSelect = 'none';

            const move = ev => {
                const h = clamp(startH + (ev.clientY - startY), MIN_PX, MAX_PX);
                topEl.style.height = h + 'px';
                topEl.style.flexShrink = '0';
            };

            const up = ev => {
                const h = clamp(startH + (ev.clientY - startY), MIN_PX, MAX_PX);
                topEl.style.height = h + 'px';
                topEl.style.flexShrink = '0';
                save(saveKey, h);
                handle.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', up);
            };

            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
        });

        // Double-click to reset to 50/50
        handle.addEventListener('dblclick', () => {
            const topEl = document.querySelector(topSelector);
            if (topEl) { topEl.style.height = '50%'; topEl.style.flexShrink = ''; }
            try { localStorage.removeItem('sl-' + saveKey); } catch (_) { }
        });
    }

    /* ── Init ─────────────────────────────────────────────────────── */
    function init() {
        restore();
        attachColResizer('resizer-col');
        attachRowResizer('resizer-left-row', '.panel-chat', 'chat-h');
        attachRowResizer('resizer-right-row', '.panel-chart', 'chart-h');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
