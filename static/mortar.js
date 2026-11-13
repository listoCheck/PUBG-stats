// PUBG XY is in centimeters; terrain elevations and all results are meters.
// This is geometric distance, not a ballistic mortar range setting.
function calculateMortarDistance(a, b, heightA, heightB) {
    if (![a?.x, a?.y, b?.x, b?.y].every(value => typeof value === 'number' && Number.isFinite(value))) {
        throw new RangeError('Map coordinates must be finite numbers');
    }
    const elevation = value => {
        if (typeof value !== 'number' && typeof value !== 'string') return null;
        if (typeof value === 'string' && !value.trim()) return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    };
    const horizontal = Math.hypot(b.x - a.x, b.y - a.y) / 100;
    const hA = elevation(heightA), hB = elevation(heightB);
    const delta = hA !== null && hB !== null ? hB - hA : null;
    return {horizontal, delta, distance: delta !== null ? Math.hypot(horizontal, delta) : null};
}

// Approximate empirical trajectory from mortarkiller_desktop; heights are metres.
let cachedMortarAim = null;
function calculateMortarAim(horizontal, delta) {
    if (typeof horizontal !== 'number' || !Number.isFinite(horizontal) || horizontal < 0 ||
        typeof delta !== 'number' || !Number.isFinite(delta)) return null;
    if (cachedMortarAim && cachedMortarAim.horizontal === horizontal && cachedMortarAim.delta === delta) return cachedMortarAim.result;
    const ranges = [121,133,145,157,169,181,193,204,216,228,239,250,262,273,284,295,307,317,328,339,350,360,371,381,391,401,411,421,431,440,450,459,468,477,486,495,503,512,520,528,536,544,551,559,566,573,580,587,593,600,606,612,618,624,629,634,639,644,649,653,658,662,666,669,673,676,679,682,685,687,689,691,693,695,696,697,698,699,699,700,700];
    let best = null;
    for (let i = 0; i < ranges.length; i++) {
        const angle = 85.5 - i * .5, radians = angle / 180 * 3.14;
        let height = 151 ** 2 * Math.sin(radians) ** 2 / (2 * 32.16) - 17.8 - delta;
        if (height < 0) continue; // Target is above the apex: the descending model cannot solve it.
        let x = ranges[i] / 2, t = 0;
        while (height >= 0) { const vy = 32.16 * t; t += .01; x += 151 * Math.cos(radians) * .01; height -= vy * .01; }
        const error = Math.abs(x - horizontal);
        if (error < 10 && (!best || error < best.error)) best = {aim:ranges[i], angle, predicted:x, error};
    }
    if (best && best.error > 0) {
        const signedError = best.predicted - horizontal, direction = Math.sign(signedError);
        const index = Math.round((85.5 - best.angle) / .5), other = index - direction;
        if (other >= 0 && other < ranges.length && !(best.angle <= 49 && signedError <= 0)) {
            let refined = best;
            for (let step = 1; step < 5; step++) {
                const angle = best.angle + direction * step * .1;
                const aim = Math.round(ranges[index] + (ranges[other] - ranges[index]) * step / 5);
                const radians = angle / 180 * 3.14;
                let height = 151 ** 2 * Math.sin(radians) ** 2 / (2 * 32.16) - 17.8 - delta;
                if (height < 0) continue;
                let x = aim / 2, t = 0;
                while (height >= 0) { const vy = 32.16 * t; t += .01; x += 151 * Math.cos(radians) * .01; height -= vy * .01; }
                const error = Math.abs(x-horizontal);
                if (error < refined.error) refined = {aim, angle, predicted:x, error};
            }
            best = refined;
        }
    }
    cachedMortarAim = {horizontal, delta, result:best};
    return best;
}

(() => {
    const el = id => document.getElementById(id);
    const svg = el('mortar-svg');
    const camera = {scale: 1, x: 0, y: 0};
    const mapCamera = createMapCamera(svg, el('mortar-image'), el('mortar-viewport'), () => render());
    const scheduleRender = createMapFrame(paint);
    const scheduleControls = createMapFrame(updateControls);
    const scene = {count: -1, ring: null, impact: null, line: null, markers: []};
    let lastSceneKey = '', lastSceneUnit = NaN;
    const sizes = {Sanhok_Main: 408000, Paramo_Main: 306000,
        Karakin_Main: 204000, Range_Main: 204000, Haven_Main: 102000};
    let points = [], initialized = false, terrainRequest = 0;
    let selectedMap = 'Erangel_Main', heights = ['', ''];
    let terrainStatus = 'idle', terrainController = null;
    let mode = 'a', pinch = null, mapReady = false;
    const touches = new Map();
    const selector = el('mortar-map-selector');
    if (matchMedia('(max-width: 720px)').matches) selector.open = false;
    const extent = () => sizes[selectedMap] || 816000;
    window.mortarMapInfo = () => ({name: selectedMap, extent: extent()});
    const meters = value => `${value.toLocaleString('ru-RU', {maximumFractionDigits: 1})} м`;
    window.impactRadiusMeters = () => { const input = el('impact-radius'); const value = Number(input.value); return input.value.trim() && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0; };
    el('impact-radius').addEventListener('input', () => { lastSceneKey = ''; render(); document.dispatchEvent(new Event('impact-radius-change')); });
    const svgPosition = event => mapCamera.point(event);

    const cards = [];
    Object.entries(mapNames).forEach(([value, name]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'map-preview-card';
        button.setAttribute('aria-pressed', String(value === selectedMap));
        const image = document.createElement('img');
        image.src = appPath(`/static/maps/previews/${value}.webp`);
        image.alt = '';
        image.width = 160;
        image.height = 100;
        image.loading = 'lazy';
        const label = document.createElement('span');
        label.textContent = name;
        button.appendChild(image);
        button.appendChild(label);
        button.addEventListener('click', () => {
            if (selectedMap === value) return;
            selectedMap = value;
            loadMap();
            if (matchMedia('(max-width: 720px)').matches) selector.open = false;
        });
        cards.push({value, button});
        el('mortar-map-cards').appendChild(button);
    });
    el('mortar-selected-name').textContent = mapNames[selectedMap];

    function render() { scheduleRender(); }
    function rebuildScene() {
        const root = el('mortar-points');
        root.replaceChildren();
        scene.count = points.length;
        scene.markers = [];
        scene.ring = points.length ? svgElement('circle', {fill: '#62d4cf0b', stroke: '#62d4cf',
            'pointer-events': 'none'}, root) : null;
        if (scene.ring) svgElement('title', {}, scene.ring).textContent = 'Номинальная максимальная дальность: 700 м';
        scene.impact = points.length === 2 ? svgElement('circle', {class:'mortar-impact-ring', fill:'#f2756822', stroke:'#f27568', 'pointer-events':'none'}, root) : null;
        scene.line = points.length === 2 ? svgElement('line', {stroke: '#ffd36c'}, root) : null;
        points.forEach((_, index) => {
            const group = svgElement('g', {}, root);
            svgElement('circle', {r: 7, fill: index ? '#f27568' : '#62d4cf', stroke: '#fff', 'stroke-width': 2}, group);
            svgElement('text', {x: 12, y: -10, class: 'measurement-label'}, group).textContent = index ? 'B · Цель' : 'A · Миномёт';
            scene.markers.push(group);
        });
    }
    function paint() {
        const geometry = mapCamera.measure();
        if (!geometry) return;
        const unit = 1 / (geometry.pixelsPerUnit * camera.scale);
        const key = `${extent()}:${window.impactRadiusMeters()}:${points.map(p => `${p.x},${p.y}`).join(';')}`;
        mapCamera.apply(camera);
        // Panning updates the camera only, not the range circle or marker DOM.
        if (key === lastSceneKey && unit === lastSceneUnit) return;
        if (scene.count !== points.length) rebuildScene();
        lastSceneKey = key; lastSceneUnit = unit;
        const xy = p => ({x: p.x / extent() * 100, y: p.y / extent() * 100});
        if (scene.ring) {
            const a = xy(points[0]);
            scene.ring.setAttribute('cx', a.x); scene.ring.setAttribute('cy', a.y);
            scene.ring.setAttribute('r', 700 * 100 / extent() * 100);
            scene.ring.setAttribute('stroke-width', 1.8 * unit);
            scene.ring.setAttribute('stroke-dasharray', `${7 * unit} ${4 * unit}`);
        }
        if (scene.impact) {
            const b = xy(points[1]), radius = window.impactRadiusMeters();
            scene.impact.setAttribute('cx', b.x); scene.impact.setAttribute('cy', b.y);
            scene.impact.setAttribute('r', radius * 100 / extent() * 100);
            scene.impact.setAttribute('stroke-width', 1.8 * unit);
            scene.impact.setAttribute('visibility', radius > 0 ? 'visible' : 'hidden');
        }
        if (scene.line) {
            const a = xy(points[0]), b = xy(points[1]);
            for (const [attr, value] of Object.entries({x1: a.x, y1: a.y, x2: b.x, y2: b.y,
                'stroke-width': 2 * unit, 'stroke-dasharray': `${6 * unit} ${4 * unit}`})) scene.line.setAttribute(attr, value);
        }
        scene.markers.forEach((node, index) => {
            const p = xy(points[index]);
            node.setAttribute('transform', `translate(${p.x} ${p.y}) scale(${unit})`);
        });
    }

    async function refreshTerrain() {
        const requestId = ++terrainRequest;
        terrainController?.abort();
        const controller = new AbortController();
        terrainController = controller;
        heights = ['', ''];
        terrainStatus = points.length ? 'loading' : 'idle';
        el('mortar-error').textContent = '';
        update();
        if (!points.length) return;
        const requestedPoints = points.map(point => ({...point}));
        try {
            const response = await fetch(appPath('/api/terrain-height'), {
                method: 'POST', headers: {'Content-Type': 'application/json'}, signal: controller.signal,
                body: JSON.stringify({map: selectedMap, points: requestedPoints})
            });
            const data = await response.json();
            if (requestId !== terrainRequest) return;
            if (!response.ok) {
                terrainStatus = data.supported === false ? 'unavailable' : 'error';
                throw new Error(data.error || 'Не удалось загрузить высоты');
            }
            if (!Array.isArray(data.heights) || data.heights.length !== requestedPoints.length ||
                !data.heights.every(value => typeof value === 'number' && Number.isFinite(value))) {
                throw new Error('Сервер вернул некорректные данные высоты');
            }
            heights = [data.heights[0], data.heights.length > 1 ? data.heights[1] : ''];
            terrainStatus = 'ready';
        } catch (error) {
            if (requestId !== terrainRequest || error.name === 'AbortError') return;
            if (terrainStatus !== 'unavailable') terrainStatus = 'error';
            el('mortar-error').textContent = error.message;
        }
        if (requestId === terrainRequest) update();
    }

    function update() { render(); scheduleControls(); }
    function setText(id, text) { if (el(id).textContent !== text) el(id).textContent = text; }
    function updateControls() {
        const result = points.length === 2 ? calculateMortarDistance(points[0], points[1], heights[0], heights[1]) : null;
        const missing = terrainStatus === 'loading' ? 'Расчёт…' : 'Нет данных высоты';
        const distance = result ? (result.distance === null ? missing : meters(result.distance)) : '—';
        const horizontal = result ? meters(result.horizontal) : '—';
        const delta = result ? (result.delta === null ? missing : `${result.delta > 0 ? '+' : ''}${meters(result.delta)}`) : '—';
        const solution = result && result.delta !== null ? calculateMortarAim(result.horizontal, result.delta) : null;
        const aim = !result ? '—' : result.delta === null ? missing : solution ? meters(solution.aim) : 'Нет решения';
        setText('mortar-aim', aim);
        setText('mortar-map-aim', aim);
        // Both views consume exactly the same result; never substitute planar distance.
        setText('mortar-horizontal', horizontal);
        setText('mortar-distance', distance);
        setText('mortar-height', delta);
        setText('mortar-map-horizontal', horizontal);
        setText('mortar-map-height', delta);
        setText('mortar-map-distance', result ? distance : points.length ? 'Выберите цель B' : 'Выберите миномёт A');
        setText('mortar-map-note', result ? (terrainStatus === 'ready' ? 'Высоты рельефа · оценка' :
            terrainStatus === 'loading' ? 'Получаю высоты точек…' : el('mortar-error').textContent || 'Нет данных высоты') :
            'Коснитесь карты или щёлкните мышью');
        setText('mortar-instruction', mode === 'pan' ? 'Перемещайте карту и масштабируйте двумя пальцами.'
            : mode === 'a' ? 'Укажите позицию миномёта A.' : 'Укажите цель B. Миномёт A останется на месте.');
        for (const name of ['a', 'b', 'pan']) {
            for (const prefix of ['mode-', 'map-mode-']) {
                const button = el(`${prefix}${name}`), pressed = String(mode === name);
                if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
                if (name === 'b') button.disabled = !points.length;
            }
        }
    }

    function resetCamera() {
        Object.assign(camera, {scale: 1, x: 0, y: 0});
        render();
    }

    function loadMap() {
        el('mortar-selected-name').textContent = mapNames[selectedMap];
        document.dispatchEvent(new CustomEvent('mortar-map-change', {detail: window.mortarMapInfo()}));
        cards.forEach(({value, button}) => button.setAttribute('aria-pressed', String(value === selectedMap)));
        terrainRequest++;
        terrainController?.abort();
        terrainStatus = 'idle';
        points = [];
        mode = 'a';
        heights[0] = '';
        heights[1] = '';
        el('mortar-error').textContent = '';
        mapReady = false;
        el('mortar-loading').classList.remove('hidden');
        el('mortar-image').removeAttribute('src');
        const imageUrl = matchMedia('(max-width: 920px), (pointer: coarse)').matches
            ? appPath(`/static/maps/${selectedMap}.webp?v=2`) : mapImage(selectedMap);
        el('mortar-image').src = imageUrl;
        resetCamera();
        update();
        initialized = true;
    }

    function activate(which) {
        for (const name of ['stats', 'mortar']) {
            const selected = name === which;
            el(`${name}-page`).classList.toggle('hidden', !selected);
            el(`tab-${name}`).setAttribute('aria-selected', String(selected));
            el(`tab-${name}`).tabIndex = selected ? 0 : -1;
        }
        if (which === 'mortar') {
            el('tab-mortar').closest('nav').scrollIntoView({block: 'start', behavior: 'auto'});
            if (!initialized) loadMap();
            render();
        }
    }
    for (const name of ['stats', 'mortar']) {
        el(`tab-${name}`).addEventListener('click', () => activate(name));
        el(`tab-${name}`).addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 'stats' : event.key === 'End' ? 'mortar' : name === 'stats' ? 'mortar' : 'stats';
            activate(next);
            el(`tab-${next}`).focus();
        });
    }

    if (location.hash === '#mortar') activate('mortar');

    function zoom(next, center = {x: 50, y: 50}) {
        next = Math.max(.7, Math.min(24, next));
        const factor = next / camera.scale;
        camera.x = center.x - (center.x - camera.x) * factor;
        camera.y = center.y - (center.y - camera.y) * factor;
        camera.scale = next;
        render();
    }
    svg.addEventListener('wheel', event => {
        event.preventDefault();
        zoom(camera.scale * (event.deltaY < 0 ? 1.2 : 1 / 1.2), svgPosition(event));
    }, {passive: false});
    function worldPoint(event) {
        const p = svgPosition(event);
        return {x: (p.x - camera.x) / camera.scale / 100 * extent(),
            y: (p.y - camera.y) / camera.scale / 100 * extent()};
    }
    function validPoint(point) {
        return point.x >= 0 && point.y >= 0 && point.x <= extent() && point.y <= extent();
    }
    function place(point) {
        if (!mapReady || !validPoint(point)) return;
        if (window.screenshotCalibration?.onMapPoint) {
            window.screenshotCalibration.onMapPoint(point);
            return;
        }
        if (mode === 'pan') return;
        if (mode === 'a' || !points.length) {
            points[0] = point;
            mode = 'b';
        } else points[1] = point;
        refreshTerrain();
    }
    function pinchStart() {
        if ([...touches.values()].some(t => t.dragIndex !== null && t.moved)) refreshTerrain();
        const [a, b] = [...touches.values()];
        const center = svgPosition({clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2});
        pinch = {distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), scale: camera.scale,
            x: (center.x - camera.x) / camera.scale, y: (center.y - camera.y) / camera.scale};
        touches.forEach(touch => { touch.moved = true; touch.dragIndex = null; });
    }
    svg.addEventListener('pointerdown', event => {
        if (event.button !== 0 || touches.size >= 2) return;
        mapCamera.invalidate();
        const p = worldPoint(event), geometry = mapCamera.measure();
        const hit = mode === 'pan' ? -1 : points.findIndex(point =>
            Math.hypot(point.x - p.x, point.y - p.y) / extent() * 100 * camera.scale * geometry.pixelsPerUnit < 22);
        touches.set(event.pointerId, {x: event.clientX, y: event.clientY, startX: event.clientX,
            startY: event.clientY, moved: false, dragIndex: hit >= 0 ? hit : null});
        svg.setPointerCapture(event.pointerId);
        if (touches.size === 2) pinchStart();
    });
    svg.addEventListener('pointermove', event => {
        const touch = touches.get(event.pointerId);
        if (!touch) return;
        const previous = {clientX: touch.x, clientY: touch.y};
        touch.x = event.clientX; touch.y = event.clientY;
        if (touches.size === 2) {
            const [a, b] = [...touches.values()];
            const center = svgPosition({clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2});
            camera.scale = Math.max(.7, Math.min(24, pinch.scale * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance));
            camera.x = center.x - pinch.x * camera.scale;
            camera.y = center.y - pinch.y * camera.scale;
            render(); return;
        }
        if (Math.hypot(event.clientX - touch.startX, event.clientY - touch.startY) > 6) touch.moved = true;
        if (!touch.moved) return;
        if (touch.dragIndex !== null) {
            const p = worldPoint(event);
            if (validPoint(p)) { points[touch.dragIndex] = p; heights = ['', '']; terrainStatus = 'loading'; terrainRequest++; terrainController?.abort(); update(); }
        } else {
            const current = svgPosition(event), old = svgPosition(previous);
            camera.x += current.x - old.x; camera.y += current.y - old.y;
            render();
        }
    });
    function endPointer(event, cancelled = false) {
        const touch = touches.get(event.pointerId);
        if (!touch) return;
        touches.delete(event.pointerId);
        if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
        if (pinch) {
            pinch = null;
            touches.forEach(t => { t.moved = true; t.startX = t.x; t.startY = t.y; });
            return;
        }
        if (touch.dragIndex !== null && touch.moved) refreshTerrain();
        else if (!cancelled && !touch.moved) place(worldPoint(event));
    }
    svg.addEventListener('pointerup', event => endPointer(event));
    svg.addEventListener('pointercancel', event => endPointer(event, true));
    svg.addEventListener('lostpointercapture', event => endPointer(event, true));
    for (const name of ['a', 'b', 'pan']) {
        for (const prefix of ['mode-', 'map-mode-']) el(`${prefix}${name}`).addEventListener('click', () => { mode = name; update(); });
    }
    el('mortar-fit').addEventListener('click', () => {
        if (!points.length) return resetCamera();
        const xs = points.map(p => p.x / extent() * 100), ys = points.map(p => p.y / extent() * 100);
        const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 5);
        camera.scale = Math.min(16, 65 / span);
        camera.x = 50 - (Math.min(...xs) + Math.max(...xs)) / 2 * camera.scale;
        camera.y = 50 - (Math.min(...ys) + Math.max(...ys)) / 2 * camera.scale;
        render();
    });
    el('mortar-fullscreen').addEventListener('click', async () => {
        const shell = el('mortar-map-shell');
        if (document.fullscreenElement) return document.exitFullscreen();
        if (shell.requestFullscreen) {
            try { await shell.requestFullscreen(); return; } catch (_) { /* Use an in-page expanded map. */ }
        }
        const expanded = shell.classList.toggle('map-expanded');
        document.body.classList.toggle('map-is-expanded', expanded);
        el('mortar-fullscreen').setAttribute('aria-pressed', String(expanded));
        render();
    });
    document.addEventListener('fullscreenchange', () => {
        el('mortar-fullscreen').setAttribute('aria-pressed', String(Boolean(document.fullscreenElement)));
        render();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            el('mortar-map-shell').classList.remove('map-expanded');
            document.body.classList.remove('map-is-expanded');
            el('mortar-fullscreen').setAttribute('aria-pressed', 'false');
        }
    });
    el('mortar-clear').addEventListener('click', () => {
        terrainRequest++;
        terrainController?.abort();
        terrainStatus = 'idle';
        points = [];
        mode = 'a';
        heights[0] = '';
        heights[1] = '';
        update();
    });
    el('mortar-reset').addEventListener('click', resetCamera);
    el('mortar-plus').addEventListener('click', () => zoom(camera.scale * 1.35));
    el('mortar-minus').addEventListener('click', () => zoom(camera.scale / 1.35));
    el('mortar-image').addEventListener('load', async () => {
        const image = el('mortar-image'), source = image.currentSrc || image.src;
        try { await image.decode(); } catch (_) { return; }
        if ((image.currentSrc || image.src) !== source) return;
        render();
        el('mortar-loading').classList.add('hidden');
        await new Promise(requestAnimationFrame);
        if ((image.currentSrc || image.src) === source) mapReady = true;
    });
    el('mortar-image').addEventListener('error', () => {
        mapReady = false;
        el('mortar-loading').classList.add('hidden');
        el('mortar-error').textContent = 'Не удалось загрузить карту. Проверьте файлы static/maps.';
    });

})();
