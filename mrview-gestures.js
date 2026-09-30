/* Translate trackpad pinches to native zoom shortcuts; defaults to MrView Ctrl +/-. */
(function (root) {
    function installMrViewGestures(screen, rfb, options = {}) {
        let connected = false;
        let delta = 0;
        let lastWheel = 0;
        let scale = null;
        let safariGesture = false;
        const now = options.now || Date.now;
        const zoomKeys = options.zoomKeys || [[0x2b, 'Equal'], [0x2d, 'Minus']];
        function zoom(direction) {
            if (!connected) return;
            // Use public noVNC key APIs; never leave Control pressed remotely.
            rfb.sendKey(0xffe3, 'ControlLeft', true);
            try {
                rfb.sendKey(...zoomKeys[direction > 0 ? 0 : 1]);
            } finally {
                rfb.sendKey(0xffe3, 'ControlLeft', false);
            }
        }
        function accumulate(value) {
            if (!Number.isFinite(value)) return;
            delta += Math.max(-60, Math.min(60, value));
            while (Math.abs(delta) >= 12) {
                const direction = Math.sign(delta);
                zoom(direction);
                delta -= direction * 12;
            }
        }
        function cancel(event) { event.preventDefault(); event.stopImmediatePropagation(); }
        function wheel(event) {
            // Chromium/Firefox expose a trackpad pinch as Ctrl+wheel.
            // Leave ordinary scrolling to noVNC for slice navigation.
            if (!event.ctrlKey || !connected) return;
            cancel(event);
            if (safariGesture) return;
            const time = now();
            if (time - lastWheel > 200) delta = 0;
            lastWheel = time;
            accumulate(-event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 120 : 1));
        }
        function start(event) {
            if (!connected) return;
            cancel(event); safariGesture = true; scale = event.scale; delta = 0;
        }
        function change(event) {
            if (!connected || !safariGesture) return;
            cancel(event);
            if (event.scale > 0 && scale > 0) accumulate(Math.log(event.scale / scale) * 240);
            scale = event.scale;
        }
        function end(event) {
            if (!safariGesture) return;
            cancel(event); safariGesture = false; scale = null; delta = 0;
        }
        function connect() { connected = true; }
        function disconnect() { connected = false; delta = 0; scale = null; safariGesture = false; }
        const handlers = { wheel, gesturestart: start, gesturechange: change, gestureend: end };
        for (const [name, handler] of Object.entries(handlers))
            screen.addEventListener(name, handler, { capture: true, passive: false });
        rfb.addEventListener('connect', connect);
        rfb.addEventListener('disconnect', disconnect);
        return { zoom, dispose() {
            for (const [name, handler] of Object.entries(handlers)) screen.removeEventListener(name, handler, true);
            rfb.removeEventListener('connect', connect); rfb.removeEventListener('disconnect', disconnect);
            disconnect();
        } };
    }
    if (typeof module !== 'undefined') module.exports = installMrViewGestures;
    else root.installMrViewGestures = installMrViewGestures;
})(typeof window === 'undefined' ? globalThis : window);
