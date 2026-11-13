(() => {
    const el = id => document.getElementById(id);
    const svg = el('screenshot-svg'), viewport = el('screenshot-viewport'), marks = el('screenshot-marks'), image = el('screenshot-image');
    const shell = el('screenshot-map-shell'), ns = 'http://www.w3.org/2000/svg';
    const tool = el('screenshot-tool');
    let file = null, bitmap = null, registration = null, selected = [null, null];
    let selectedMode = 0, analysisId = 0, heightId = 0, analyzeController = null, heightController = null;
    let calibration = null, objectUrl = null, baseMatrix = null, markerNodes = [];
    const camera = {x: 0, y: 0, scale: 1}, pointers = new Map();
    let pinch = null;
    function cancelCalibration() {
        calibration = null;
        window.screenshotCalibration = null;
        el('screenshot-calibrate').textContent = 'Совместить по ориентирам';
    }
    const currentColor = () => document.querySelector('input[name="screenshot-color"]:checked').value;
    const meters = value => `${value.toLocaleString('ru-RU', {maximumFractionDigits: 1})} м`;
    const status = (message, error = false) => {
        el('screenshot-status').textContent = message;
        el('screenshot-status').classList.toggle('error', error);
    };
    function resetValues() {
        for (const id of ['screenshot-horizontal', 'screenshot-height', 'screenshot-distance']) el(id).textContent = '—';
    }
    function updateModes() {
        el('screenshot-mode-a').setAttribute('aria-pressed', String(selectedMode === 0));
        el('screenshot-mode-b').setAttribute('aria-pressed', String(selectedMode === 1));
        for (const [name, index] of [['a',0],['b',1],['pan',2]]) el(`screenshot-map-mode-${name}`).setAttribute('aria-pressed', String(selectedMode === index));
    }
    function node(name, attributes = {}, parent = marks) {
        const value = document.createElementNS(ns, name);
        for (const [key, item] of Object.entries(attributes)) value.setAttribute(key, item);
        parent.appendChild(value); return value;
    }
    function matrix() {
        if (!baseMatrix) baseMatrix = svg.getScreenCTM();
        return baseMatrix;
    }
    function basePoint(event) {
        const m = matrix();
        return m ? new DOMPoint(event.clientX, event.clientY).matrixTransform(m.inverse()) : null;
    }
    function imagePoint(event) {
        const p = basePoint(event);
        return p && {x: (p.x - camera.x) / camera.scale, y: (p.y - camera.y) / camera.scale};
    }
    const render = createMapFrame(() => {
        viewport.setAttribute('transform', `translate(${camera.x} ${camera.y}) scale(${camera.scale})`);
        const m = matrix(); if (!m) return;
        const unit = 1 / (Math.hypot(m.a, m.b) * camera.scale);
        for (const marker of markerNodes) marker.node.setAttribute('transform', `translate(${marker.x} ${marker.y}) scale(${unit})`);
    });
    function draw() {
        marks.replaceChildren(); markerNodes = [];
        if (!bitmap) return;
        for (const c of registration?.candidates || []) {
            node('circle', {cx:c.x, cy:c.y, r:Math.max(c.width,c.height)/2 + 2,
                fill:'none', stroke:'#f9d86a', 'stroke-width':2, 'vector-effect':'non-scaling-stroke'});
        }
        if (selected[0] && registration) {
            const t = registration.transform, cmPerPixel = Math.hypot(t[0], t[3]);
            if (Number.isFinite(cmPerPixel) && cmPerPixel > 0) {
                const ring = node('circle', {cx:selected[0].x, cy:selected[0].y, r:70000/cmPerPixel,
                    fill:'none', stroke:'#62d4cf', 'stroke-width':1.8, 'stroke-dasharray':'7 4', 'vector-effect':'non-scaling-stroke'});
                node('title', {}, ring).textContent = 'Номинальная максимальная дальность: 700 м';
            }
        }
        if (selected.every(Boolean)) node('line', {x1:selected[0].x, y1:selected[0].y, x2:selected[1].x, y2:selected[1].y,
            stroke:'#fff', 'stroke-width':2, 'vector-effect':'non-scaling-stroke'});
        function marker(point, label, color, size = 7) {
            const group = node('g'); markerNodes.push({node:group, x:point.x, y:point.y});
            node('circle', {r:size, fill:color, stroke:'#fff', 'stroke-width':2}, group);
            const text = node('text', {x:10, y:-8, fill:'#fff', stroke:'#111', 'stroke-width':3,
                'stroke-linejoin':'round', 'paint-order':'stroke fill', 'font-size':14, 'font-weight':'bold', 'font-family':'Arial,sans-serif'}, group);
            text.textContent = label;
        }
        (calibration?.screen || []).forEach((point, i) => marker(point, String(i + 1), '#263a44', 9));
        selected.forEach((point, i) => { if (point) marker(point, i ? 'B' : 'A', i ? '#f27568' : '#62d4cf'); });
        render();
    }
    const scheduleDraw = createMapFrame(draw);
    function toWorld(point) {
        const [a,b,c,d,e,f] = registration.transform;
        return {x: a * point.x + b * point.y + c, y: d * point.x + e * point.y + f};
    }
    async function calculate() {
        const requestId = ++heightId;
        heightController?.abort();
        const controller = new AbortController(); heightController = controller;
        resetValues(); draw();
        if (!registration || !selected.every(Boolean)) return;
        const map = window.mortarMapInfo(), world = selected.map(toWorld);
        if (world.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) ||
            p.x < 0 || p.y < 0 || p.x > map.extent || p.y > map.extent)) {
            status('Точка находится за пределами выбранной карты. Уточните её на скриншоте.', true); return;
        }
        const planar = calculateMortarDistance(world[0], world[1], '', '');
        el('screenshot-horizontal').textContent = meters(planar.horizontal);
        el('screenshot-height').textContent = 'Расчёт…'; el('screenshot-distance').textContent = 'Расчёт…';
        try {
            const response = await fetch('/api/terrain-height', {method: 'POST', signal: controller.signal,
                headers: {'Content-Type': 'application/json'}, body: JSON.stringify({map: map.name, points: world})});
            const data = await response.json();
            if (requestId !== heightId) return;
            if (!response.ok) throw new Error(data.error || 'Не удалось получить высоты');
            if (!Array.isArray(data.heights) || data.heights.length !== 2 ||
                !data.heights.every(v => typeof v === 'number' && Number.isFinite(v))) throw new Error('Некорректные данные высоты');
            const result = calculateMortarDistance(world[0], world[1], data.heights[0], data.heights[1]);
            el('screenshot-height').textContent = `${result.delta > 0 ? '+' : ''}${meters(result.delta)}`;
            el('screenshot-distance').textContent = meters(result.distance);
        } catch (error) {
            if (requestId !== heightId || error.name === 'AbortError') return;
            el('screenshot-height').textContent = 'Нет данных'; el('screenshot-distance').textContent = 'Нет данных высоты';
            status(error.message, true);
        }
    }
    async function analyze() {
        cancelCalibration();
        const requestId = ++analysisId; ++heightId;
        analyzeController?.abort(); heightController?.abort();
        const controller = new AbortController(); analyzeController = controller;
        registration = null; selected = [null, null]; selectedMode = 0; updateModes(); resetValues(); draw();
        if (!file || !bitmap) return;
        const map = window.mortarMapInfo(), color = currentColor();
        const params = new URLSearchParams({map: map.name, color});
        status(`Распознаю скриншот: ${mapNames[map.name]}…`);
        try {
            const response = await fetch(`/api/screenshot/recognize?${params}`, {
                method:'POST', body:file, headers:{'Content-Type':file.type}, signal:controller.signal
            });
            if (response.status === 429) throw new Error('Слишком много запросов распознавания. Подождите немного и повторите.');
            if (response.status === 413) throw new Error('Размер скриншота должен быть не больше 12 МБ.');
            const result = await response.json();
            if (requestId !== analysisId) return;
            if (!response.ok) throw new Error(result.error || 'Не удалось распознать изображение');
            if (result.width !== bitmap.width || result.height !== bitmap.height ||
                !Array.isArray(result.transform) || result.transform.length !== 6 || !result.transform.every(Number.isFinite) ||
                !Array.isArray(result.candidates)) throw new Error('Размер изображения или данные распознавания не совпадают');
            registration = result;
            const candidates = result.candidates;
            // Auto-suggest only the unambiguous case: one compact player and one elongated pin.
            if (candidates.length === 2) {
                const pins = candidates.filter(c => c.height >= c.width * 1.13);
                const players = candidates.filter(c => c.height < c.width * 1.13);
                if (pins.length === 1 && players.length === 1) {
                    selected = [{x:players[0].x, y:players[0].y}, {x:pins[0].x, y:pins[0].tip_y}];
                    selectedMode = 1; updateModes();
                    status('Точки определены автоматически. Проверьте A и B на скриншоте и при необходимости поправьте.');
                    calculate(); return;
                }
            }
            status(candidates.length ? `Карта определена, найдено цветных подсказок: ${candidates.length}. Укажите A и B на скриншоте.`
                : 'Карта определена. Укажите A — положение игрока, затем B — вашу метку.');
            draw();
        } catch (error) {
            if (requestId !== analysisId || error.name === 'AbortError') return;
            status(error.message, true); draw();
        }
    }
    async function loadFile(input) {
        if (!input || !['image/png','image/jpeg','image/webp'].includes(input.type)) {
            status('Выберите скриншот PNG, JPEG или WebP.', true); return;
        }
        if (input.size > 12 * 1024 * 1024) { status('Скриншот больше 12 МБ.', true); return; }
        cancelCalibration();
        const loadId = ++analysisId; ++heightId; analyzeController?.abort(); heightController?.abort();
        try {
            const next = await createImageBitmap(input, {imageOrientation: 'from-image'});
            if (loadId !== analysisId) { next.close(); return; }
            bitmap = {width: next.width, height: next.height}; next.close();
            file = input; registration = null; selected = [null, null];
            const oldUrl = objectUrl; objectUrl = URL.createObjectURL(input);
            image.setAttribute('href', objectUrl); image.setAttribute('width', bitmap.width); image.setAttribute('height', bitmap.height);
            svg.setAttribute('viewBox', `0 0 ${bitmap.width} ${bitmap.height}`);
            if (oldUrl) URL.revokeObjectURL(oldUrl);
            camera.x = camera.y = 0; camera.scale = 1; baseMatrix = null;
            el('screenshot-result').classList.remove('hidden'); tool.open = true;
            resetValues(); draw(); analyze();
        } catch (_) { status('Не удалось открыть скриншот.', true); }
    }
    el('screenshot-paste').addEventListener('click', async () => {
        try {
            if (!navigator.clipboard?.read) throw new Error();
            const items = await navigator.clipboard.read();
            for (const item of items) {
                const type = item.types.find(t => ['image/png','image/jpeg','image/webp'].includes(t));
                if (type) { await loadFile(await item.getType(type)); return; }
            }
            status('В буфере не найден скриншот.', true);
        } catch (_) { status('Не удалось прочитать буфер. Нажмите Ctrl+V или выберите файл.', true); }
    });
    document.addEventListener('paste', event => {
        if (el('mortar-page').classList.contains('hidden') || event.target.isContentEditable ||
            ['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)) return;
        const image = [...(event.clipboardData?.items || [])].find(item => item.type.startsWith('image/'));
        if (image) { event.preventDefault(); loadFile(image.getAsFile()); }
    });
    el('screenshot-file').addEventListener('change', event => { if (event.target.files[0]) loadFile(event.target.files[0]); event.target.value = ''; });
    document.querySelectorAll('input[name="screenshot-color"]').forEach(input => input.addEventListener('change', () => { if (file) analyze(); }));
    document.addEventListener('mortar-map-change', () => { if (file && bitmap) analyze(); });
    el('screenshot-mode-a').addEventListener('click', () => { cancelCalibration(); selectedMode = 0; updateModes(); });
    el('screenshot-mode-b').addEventListener('click', () => { cancelCalibration(); selectedMode = 1; updateModes(); });
    function zoomAt(factor, center) {
        if (!bitmap) return;
        const next = Math.max(.7, Math.min(24, camera.scale * factor));
        camera.x = center.x - (center.x - camera.x) * next / camera.scale;
        camera.y = center.y - (center.y - camera.y) * next / camera.scale;
        camera.scale = next; render();
    }
    const center = () => ({x: bitmap.width / 2, y: bitmap.height / 2});
    el('screenshot-zoom-in').addEventListener('click', () => { if (bitmap) zoomAt(1.4, center()); });
    el('screenshot-zoom-out').addEventListener('click', () => { if (bitmap) zoomAt(1 / 1.4, center()); });
    el('screenshot-focus-points').addEventListener('click', () => {
        const points = selected.filter(Boolean); if (!bitmap || !points.length) return;
        const xs = points.map(p => p.x), ys = points.map(p => p.y);
        const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
        camera.scale = Math.min(16, .65 * Math.min(bitmap.width / Math.max(maxX-minX, bitmap.width*.05), bitmap.height / Math.max(maxY-minY, bitmap.height*.05)));
        camera.x = bitmap.width/2 - (minX+maxX)/2*camera.scale;
        camera.y = bitmap.height/2 - (minY+maxY)/2*camera.scale; render();
    });
    el('screenshot-zoom-fit').addEventListener('click', () => { camera.x = camera.y = 0; camera.scale = 1; render(); });
    for (const [name, index] of [['a',0],['b',1],['pan',2]]) {
        el(`screenshot-map-mode-${name}`).addEventListener('click', () => { if (index !== 2) cancelCalibration(); selectedMode = index; updateModes(); });
    }
    el('screenshot-fullscreen').addEventListener('click', async () => {
        if (document.fullscreenElement === shell) { await document.exitFullscreen(); return; }
        if (shell.classList.contains('map-expanded')) { shell.classList.remove('map-expanded'); document.body.classList.remove('map-is-expanded'); baseMatrix = null; render(); return; }
        if (shell.requestFullscreen) { try { await shell.requestFullscreen(); return; } catch (_) {} }
        shell.classList.add('map-expanded'); document.body.classList.add('map-is-expanded');
        el('screenshot-fullscreen').setAttribute('aria-pressed', 'true'); baseMatrix = null; render();
    });
    document.addEventListener('fullscreenchange', () => {
        el('screenshot-fullscreen').setAttribute('aria-pressed', String(document.fullscreenElement === shell)); baseMatrix = null; render();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && shell.classList.contains('map-expanded')) {
            shell.classList.remove('map-expanded'); document.body.classList.remove('map-is-expanded');
            el('screenshot-fullscreen').setAttribute('aria-pressed', 'false'); baseMatrix = null; render();
        }
    });
    el('screenshot-reset').addEventListener('click', () => { cancelCalibration(); ++heightId; heightController?.abort(); selected = [null, null]; selectedMode = 0; updateModes(); resetValues(); draw(); });
    el('screenshot-calibrate').addEventListener('click', () => {
        if (calibration) { cancelCalibration(); status('Совмещение отменено.'); draw(); return; }
        ++analysisId; ++heightId; analyzeController?.abort(); heightController?.abort();
        registration = null; selected = [null, null]; resetValues();
        calibration = {screen: [], map: [], stage: 'screen'};
        el('screenshot-calibrate').textContent = 'Отменить совмещение';
        status('Ориентир 1: нажмите на заметный объект на скриншоте (например, перекрёсток).');
        draw();
    });
    function placePoint(point) {
        if (!point || !bitmap || point.x < 0 || point.y < 0 || point.x > bitmap.width || point.y > bitmap.height) return;
        if (calibration) {
            if (calibration.stage !== 'screen') { status('Теперь отметьте этот ориентир на карте ниже.'); return; }
            calibration.screen.push(point); calibration.stage = 'map'; draw();
            const number = calibration.screen.length;
            status(`Ориентир ${number}: отметьте тот же объект на интерактивной карте ниже. Карту можно приблизить.`);
            window.screenshotCalibration = {onMapPoint: world => {
                if (!calibration || calibration.stage !== 'map') return;
                calibration.map.push(world); window.screenshotCalibration = null;
                if (calibration.map.length === 1) {
                    calibration.stage = 'screen';
                    status('Ориентир 2: отметьте на скриншоте другой удалённый объект.');
                } else {
                    const [s1,s2] = calibration.screen, [w1,w2] = calibration.map;
                    const dx = s2.x-s1.x, dy = s2.y-s1.y, wx = w2.x-w1.x, wy = w2.y-w1.y;
                    const denominator = dx*dx + dy*dy, map = window.mortarMapInfo();
                    if (denominator < 900 || Math.hypot(wx, wy) < map.extent * .05) {
                        cancelCalibration(); status('Ориентиры слишком близко. Повторите совмещение и выберите удалённые точки.', true);
                    } else {
                        const a = (wx*dx + wy*dy) / denominator, b = (wy*dx - wx*dy) / denominator;
                        if (Math.abs(Math.atan2(b, a)) > Math.PI / 18) {
                            cancelCalibration(); status('Ориентиры не совпадают: проверьте карту и порядок точек.', true);
                        } else {
                            registration = {transform: [a,-b,w1.x-a*s1.x+b*s1.y,b,a,w1.y-b*s1.x-a*s1.y], candidates: [], manual: true};
                            cancelCalibration(); selectedMode = 0; updateModes();
                            status('Совмещение по ориентирам выполнено. Укажите A и B на скриншоте; точность зависит от выбранных ориентиров.');
                        }
                    }
                }
                draw(); tool.scrollIntoView({block: 'start', behavior: 'auto'});
            }};
            el('mortar-map-shell').scrollIntoView({block: 'center', behavior: 'auto'});
            return;
        }
        if (selectedMode === 2) return;
        if (!registration) { status('Не удалось сопоставить карту автоматически. Используйте «Совместить по ориентирам».', true); return; }
        const world = toWorld(point), map = window.mortarMapInfo();
        if (world.x < 0 || world.y < 0 || world.x > map.extent || world.y > map.extent) {
            status('Выберите точку внутри карты.', true); return;
        }
        selected[selectedMode] = point;
        if (selectedMode === 0) selectedMode = 1;
        updateModes();
        status(selected.every(Boolean) ? 'Точки выбраны. Перепроверьте положение A и B.' : 'Теперь выберите B — вашу метку.');
        calculate();
    }
    function validImagePoint(p) { return p && p.x >= 0 && p.y >= 0 && p.x <= bitmap.width && p.y <= bitmap.height; }
    svg.addEventListener('wheel', event => {
        event.preventDefault(); baseMatrix = null;
        const p = basePoint(event); if (p) zoomAt(event.deltaY < 0 ? 1.2 : 1 / 1.2, p);
    }, {passive:false});
    svg.addEventListener('pointerdown', event => {
        if (!bitmap || event.button !== 0 || pointers.size >= 2) return;
        baseMatrix = null;
        const p = imagePoint(event), m = matrix();
        const hit = selectedMode === 2 || calibration || !m ? -1 : selected.findIndex(point => point &&
            Math.hypot(point.x - p.x, point.y - p.y) * camera.scale * Math.hypot(m.a, m.b) < 22);
        pointers.set(event.pointerId, {x:event.clientX, y:event.clientY, startX:event.clientX, startY:event.clientY, moved:false, drag:hit});
        svg.setPointerCapture(event.pointerId);
        if (pointers.size === 2) {
            if ([...pointers.values()].some(t => t.moved && t.drag >= 0)) calculate();
            const [a,b] = [...pointers.values()]; const middle = basePoint({clientX:(a.x+b.x)/2,clientY:(a.y+b.y)/2});
            pinch = {distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)), scale:camera.scale,
                x:(middle.x-camera.x)/camera.scale, y:(middle.y-camera.y)/camera.scale};
            for (const touch of pointers.values()) { touch.moved = true; touch.drag = -1; }
        }
    });
    svg.addEventListener('pointermove', event => {
        const touch = pointers.get(event.pointerId); if (!touch) return;
        const old = basePoint({clientX:touch.x, clientY:touch.y});
        touch.x = event.clientX; touch.y = event.clientY;
        if (pointers.size === 2 && pinch) {
            const [a,b] = [...pointers.values()], middle = basePoint({clientX:(a.x+b.x)/2,clientY:(a.y+b.y)/2});
            camera.scale = Math.max(.7,Math.min(24,pinch.scale*Math.hypot(a.x-b.x,a.y-b.y)/pinch.distance));
            camera.x = middle.x-pinch.x*camera.scale; camera.y = middle.y-pinch.y*camera.scale; render(); return;
        }
        if (Math.hypot(event.clientX-touch.startX,event.clientY-touch.startY) > 6 && !touch.moved) {
            touch.moved = true;
            if (touch.drag >= 0) { ++heightId; heightController?.abort(); resetValues(); }
        }
        if (!touch.moved) return;
        if (touch.drag >= 0) {
            const point = imagePoint(event), world = point && registration && toWorld(point), map = window.mortarMapInfo();
            if (validImagePoint(point) && world && world.x >= 0 && world.y >= 0 && world.x <= map.extent && world.y <= map.extent) { selected[touch.drag] = point; scheduleDraw(); }
        } else {
            const now = basePoint(event); if (now && old) { camera.x += now.x-old.x; camera.y += now.y-old.y; render(); }
        }
    });
    function endPointer(event, cancelled = false) {
        const touch = pointers.get(event.pointerId); if (!touch) return;
        pointers.delete(event.pointerId);
        if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
        if (pinch) { pinch = null; for (const remaining of pointers.values()) { remaining.moved = true; remaining.drag = -1; } return; }
        if (touch.moved && touch.drag >= 0) calculate();
        else if (!cancelled && !touch.moved && touch.drag >= 0) { selectedMode = touch.drag; updateModes(); status(`Точка ${touch.drag ? 'B' : 'A'} выбрана. Перетащите её или нажмите новое место.`); }
        else if (!cancelled && !touch.moved) placePoint(imagePoint(event));
    }
    svg.addEventListener('pointerup', endPointer);
    svg.addEventListener('pointercancel', event => endPointer(event, true));
    svg.addEventListener('lostpointercapture', event => endPointer(event, true));
    const invalidate = () => { baseMatrix = null; render(); };
    window.addEventListener('scroll', invalidate, {capture:true, passive:true});
    window.addEventListener('resize', invalidate, {passive:true});
    new ResizeObserver(invalidate).observe(svg);
    for (const name of ['horizontal','height','distance']) {
        const source = el(`screenshot-${name}`), target = el(`screenshot-map-${name}`);
        new MutationObserver(() => { target.textContent = source.textContent; }).observe(source, {childList:true, characterData:true, subtree:true});
    }
})();
