// Coalesce high-frequency pointer/wheel input into one update per display frame.
function createMapFrame(draw) {
    let pending = false;
    return () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; draw(); });
    };
}

// The raster is a separate composited HTML layer. SVG changes never repaint it.
// Geometry is invalidated on resize/scroll, not measured after every DOM write.
function createMapCamera(svg, raster, viewport, onResize) {
    let geometry = null, lastSize = -1, lastPlacement = '', lastRasterTransform = '', lastVectorTransform = '';
    function invalidate() { geometry = null; }
    function measure() {
        if (geometry) return geometry;
        const rect = svg.getBoundingClientRect();
        const size = Math.min(rect.width, rect.height);
        if (!size) return null;
        geometry = {rect, size, pixelsPerUnit: size / 100,
            left: rect.left + (rect.width - size) / 2,
            top: rect.top + (rect.height - size) / 2};
        return geometry;
    }
    raster.addEventListener('load', () => { lastSize = -1; onResize(); });
    window.addEventListener('scroll', invalidate, {capture: true, passive: true});
    window.addEventListener('resize', invalidate, {passive: true});
    new ResizeObserver(() => { invalidate(); lastSize = -1; onResize(); }).observe(svg);
    return {
        measure, invalidate,
        point(event) {
            const m = measure();
            return m ? {x: (event.clientX - m.left) / m.pixelsPerUnit,
                y: (event.clientY - m.top) / m.pixelsPerUnit} : {x: 0, y: 0};
        },
        apply(camera) {
            const m = measure();
            if (!m) return;
            // Keep one native-resolution texture instead of rasterizing the image
            // again at every intermediate zoom level. Only its compositor scale changes.
            const textureSize = raster.naturalWidth || 4096;
            if (lastSize !== textureSize) {
                raster.style.width = `${textureSize}px`;
                raster.style.height = `${textureSize}px`;
                lastSize = textureSize;
            }
            // Center in the SVG's letterbox, including landscape/fullscreen views.
            const placement = `${m.rect.width},${m.rect.height},${m.size}`;
            if (placement !== lastPlacement) {
                raster.style.left = `${(m.rect.width - m.size) / 2}px`;
                raster.style.top = `${(m.rect.height - m.size) / 2}px`;
                lastPlacement = placement;
            }
            const rasterTransform = `translate3d(${camera.x * m.pixelsPerUnit}px, ${camera.y * m.pixelsPerUnit}px, 0) scale(${camera.scale * m.size / textureSize})`;
            const vectorTransform = `translate(${camera.x} ${camera.y}) scale(${camera.scale})`;
            if (rasterTransform !== lastRasterTransform) { raster.style.transform = rasterTransform; lastRasterTransform = rasterTransform; }
            if (vectorTransform !== lastVectorTransform) { viewport.setAttribute('transform', vectorTransform); lastVectorTransform = vectorTransform; }
        }
    };
}
