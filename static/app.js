const $ = id => document.getElementById(id);
let state = {mapSize: 816000, squad: [], zones: [], combat: [], airdrops: [], mapImage: ''};
let view = {scale: 1, x: 0, y: 0};
let drag = null;
const colors = ['#62d4cf', '#f0a24b', '#f27568', '#b490ff'];
const zoneColors = ['#62d4cf', '#9edc82', '#f6d36e', '#f3a755', '#f27d74', '#cf96f2', '#aebfff', '#e5e8ec'];
const playerColors = {
    'Svitoi_tapok': '#f4d03f',
    'not_trikesh': '#35c759',
    'TAMnJluEPsc': '#3285ff',
    'Na4aJlbHuK_DACHI': '#f28c28'
};

function playerColor(name, index) {
    return playerColors[name] || colors[index % colors.length]
}

function setStatus(text, error = false) {
    $('status').textContent = text;
    $('status').className = 'status' + (error ? ' error' : '')
}

const mapAliases = {
    Baltic_Main: 'Erangel_Main', Desert_Main: 'Miramar_Main', Savage_Main: 'Sanhok_Main',
    DihorOtok_Main: 'Vikendi_Main', Tiger_Main: 'Taego_Main', Neon_Main: 'Rondo_Main',
    Summerland_Main: 'Karakin_Main', Chimera_Main: 'Paramo_Main',
    Heaven_Main: 'Haven_Main', Kiki_Main: 'Deston_Main'
};
const mapNames = {
        Erangel_Main: 'Эрангель',
        Miramar_Main: 'Мирамар',
        Sanhok_Main: 'Санок',
        Vikendi_Main: 'Викенди',
        Taego_Main: 'Тэго',
        Deston_Main: 'Дэстон',
        Rondo_Main: 'Рондо',
        Karakin_Main: 'Каракин',
        Paramo_Main: 'Парамо',
        Haven_Main: 'Хейвен', Range_Main: 'Тренировочный полигон'
};

function canonicalMap(name) {
    const value = String(name || '').trim();
    return mapAliases[value] || value
}

function mapName(name) {
    return mapNames[canonicalMap(name)] || name
}

function mapImage(name, fallback) {
    const canonical = canonicalMap(name);
    const extension = ['Paramo_Main', 'Miramar_Main'].includes(canonical) ? 'jpg' : 'webp';
    return Object.hasOwn(mapNames, canonical) ? `/static/maps/${canonical}.${extension}?v=2` : (fallback || '')
}

function fmtDate(value) {
    if (!value) return 'Дата неизвестна';
    return new Date(value).toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    })
}

function esc(v) {
    return String(v).replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[c]))
}

const mainCamera = createMapCamera($('routes'), $('map-image'), $('viewport'), () => transform());
const overlay = {labels: [], drops: [], strokes: [], dots: []};
let lastMainUnit = NaN;
const scheduleMain = createMapFrame(() => {
    const geometry = mainCamera.measure();
    if (!geometry) return;
    const unit = 1 / (geometry.pixelsPerUnit * view.scale);
    mainCamera.apply(view);
    // A pan only moves two parent layers; children and labels stay untouched.
    if (unit === lastMainUnit) return;
    lastMainUnit = unit;
    overlay.strokes.forEach(({node, width, dashed}) => {
        node.style.strokeWidth = width * unit;
        if (dashed) node.style.strokeDasharray = `${4 * unit} ${3 * unit}`;
    });
    overlay.dots.forEach(node => node.setAttribute('r', 2 * unit));
    layoutCombatLabels(unit);
    overlay.drops.forEach(({node, x, y}) => node.setAttribute('transform', `translate(${x} ${y}) scale(${unit})`));
});
function pixelUnit() {
    return 1 / ((mainCamera.measure()?.pixelsPerUnit || 6) * view.scale);
}
function transform() { scheduleMain(); }

function resetView() {
    view = {scale: 1, x: 0, y: 0};
    transform()
}

function zoomAt(next, cx = 50, cy = 50) {
    const old = view.scale;
    next = Math.max(.7, Math.min(8, next));
    view.x = cx - (cx - view.x) * (next / old);
    view.y = cy - (cy - view.y) * (next / old);
    view.scale = next;
    transform()
}

function svgPoint(event) { return mainCamera.point(event); }

function clearGroup(id) {
    $(id).replaceChildren()
}

function svgElement(tag, attrs, parent) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, value));
    parent.appendChild(element);
    return element
}

const textMeasure = document.createElement('canvas').getContext('2d');
function measureCombatLabels() {
    if (!overlay.labels.length) return;
    textMeasure.font = getComputedStyle(overlay.labels[0].label).font;
    overlay.labels.forEach(item => { item.width = textMeasure.measureText(item.label.textContent).width; });
    lastMainUnit = NaN;
    transform();
}
function renderCombatSummary(s) {
    clearGroup('combat-summary');
    overlay.labels = state.combat.map(event => {
        const node = svgElement('g', {}, $('combat-summary'));
        const label = svgElement('text', {'class': 'combat-summary-text', 'font-size': 11}, node);
        label.textContent = `${event.kind} · ${event.weapon} · ${event.distance} м`;
        return {node, label, x: event.to.x / s * 100, y: event.to.y / s * 100, width: 0};
    });
    // One style read, canvas measurements: no per-label SVG layout flush.
    measureCombatLabels();
}
function layoutCombatLabels(unit) {
    const placed = new Map(), cellSize = 48;
    function cells(box) {
        const keys = [];
        for (let x = Math.floor(box.left / cellSize); x <= Math.floor(box.right / cellSize); x++)
            for (let y = Math.floor(box.top / cellSize); y <= Math.floor(box.bottom / cellSize); y++) keys.push(`${x},${y}`);
        return keys;
    }
    overlay.labels.forEach(item => {
        const x = item.x / unit, y = item.y / unit;
        const left = x + 6 + item.width > (100 - view.x) / view.scale / unit ? x - 6 - item.width : x + 6;
        let row = 0, box, keys;
        do {
            box = {left, right: left + item.width, top: y + row * 15 - 13, bottom: y + row * 15 + 2};
            keys = cells(box); row++;
        } while (row <= overlay.labels.length && keys.some(key => (placed.get(key) || []).some(p =>
            box.left < p.right && box.right > p.left && box.top < p.bottom && box.bottom > p.top)));
        keys.forEach(key => { if (!placed.has(key)) placed.set(key, []); placed.get(key).push(box); });
        item.node.setAttribute('transform', `translate(${box.left * unit} ${(box.top + 7.5) * unit}) scale(${unit})`);
    });
}
function renderAirdrops(s) {
    clearGroup('airdrops');
    overlay.drops = state.airdrops.map(drop => {
        const node = svgElement('g', {class: 'airdrop-marker'}, $('airdrops'));
        svgElement('rect', {x: -6, y: -6, width: 12, height: 12, rx: 1.5}, node);
        svgElement('path', {d: 'M-6,-1 H6 M0,-6 V6'}, node);
        svgElement('title', {}, node).textContent = `Приземлившийся эйрдроп${drop.landed_at ? ' · ' + new Date(drop.landed_at).toLocaleTimeString('ru-RU') : ''}`;
        return {node, x: drop.x / s * 100, y: drop.y / s * 100};
    });
}

function renderFlightPath(s) {
    const root = $('flight-route');
    clearGroup('flight-route');
    if (!state.flight || state.flight.length < 2) return;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('points', state.flight.map(p => `${p.x / s * 100},${p.y / s * 100}`).join(' '));
    line.setAttribute('class', 'flight-line');
    root.appendChild(line)
}

function renderRoutes() {
    const s = state.mapSize || 816000, image = $('map-image');
    if (state.mapImage) image.src = state.mapImage; else image.removeAttribute('src');
    clearGroup('zones');
    clearGroup('squad-routes');
    clearGroup('combat-lines');
    const zones = $('zones'), routes = $('squad-routes'), combat = $('combat-lines');
    state.zones.forEach((z, i) => {
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('cx', z.x / s * 100);
        c.setAttribute('cy', z.y / s * 100);
        c.setAttribute('r', z.radius / s * 100);
        c.setAttribute('class', i === state.zones.length - 1 ? 'safe-zone last' : 'safe-zone');
        c.style.stroke = zoneColors[i % zoneColors.length];
        if (z.phase) svgElement('title', {}, c).textContent = `Фаза ${z.phase}`;
        zones.appendChild(c)
    });
    state.squad.forEach((m, i) => {
        if (m.points.length < 2) return;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        line.setAttribute('points', m.points.map(p => `${p.x / s * 100},${p.y / s * 100}`).join(' '));
        line.setAttribute('stroke', playerColor(m.name, i));
        line.setAttribute('class', 'squad-route');
        routes.appendChild(line)
    });
    state.combat.forEach(e => {
        svgElement('line', {x1: e.from.x / s * 100, y1: e.from.y / s * 100,
            x2: e.to.x / s * 100, y2: e.to.y / s * 100, class: 'combat-line'}, combat);
        svgElement('circle', {cx: e.to.x / s * 100, cy: e.to.y / s * 100, class: 'combat-dot'}, combat)
    });
    renderFlightPath(s);
    renderCombatSummary(s);
    renderAirdrops(s);
    overlay.strokes = [...document.querySelectorAll('.squad-route, .combat-line, .flight-line, .safe-zone')].map(node => ({
        node, width: node.classList.contains('squad-route') || node.classList.contains('flight-line') ? 1.6 : node.classList.contains('combat-line') ? 1.4 : 1.3,
        dashed: node.classList.contains('combat-line') || node.classList.contains('flight-line')
    }));
    overlay.dots = [...document.querySelectorAll('.combat-dot')];
    lastMainUnit = NaN;
    transform()
}

function renderSquad() {
    const box = $('squad');
    box.className = 'markers';
    box.innerHTML = state.squad.map((m, i) => `<div class="marker-row"><div><b style="color:${playerColor(m.name, i)}">${esc(m.name)}</b><small>${m.points.length} точек маршрута</small></div></div>`).join('') || '<div class="markers empty">Нет данных о маршруте</div>'
}

function renderMatch(d) {
    const map = canonicalMap(d.map);
    state.mapSize = ({Paramo_Main: 306000, Sanhok_Main: 408000,
        Karakin_Main: 204000, Range_Main: 204000, Haven_Main: 102000})[map]
        || (Object.hasOwn(mapNames, map) ? 816000 : d.map_size || 816000);
    state.mapImage = mapImage(map, d.map_image);
    state.squad = d.squad || [];
    state.flight = d.flight_path || [];
    state.zones = d.zone_pattern || [];
    $('zone-phases').replaceChildren();
    state.zones.forEach((zone, i) => {
        const chip = document.createElement('span'), dot = document.createElement('i');
        chip.className = 'zone-phase'; dot.style.borderColor = zoneColors[i % zoneColors.length];
        chip.append(dot, document.createTextNode(zone.phase ? `Фаза ${zone.phase}` : `Зона ${i + 1}`));
        $('zone-phases').appendChild(chip);
    });
    state.combat = d.combat_lines || [];
    state.airdrops = d.airdrops || [];
    const s = d.match_stats || {};
    $('map-name').textContent = mapName(d.map);
    $('rank').textContent = s.rank ?? '—';
    $('kills').textContent = s.kills ?? '—';
    $('assists').textContent = s.assists ?? '—';
    $('damage').textContent = s.damage ?? '—';
    $('walk').textContent = (s.walk ?? '—') + ' км';
    $('vehicle').textContent = (s.vehicle ?? '—') + ' км';
    $('duration').textContent = Math.floor((s.duration || 0) / 60) + ' мин';
    $('team-id').textContent = s.team_id ?? '—';
    $('note').textContent = d.note;
    $('combat-list').className = 'markers';
    $('combat-list').innerHTML = state.combat.map(e => `<div class="marker-row combat-row"><div><b>${esc(e.kind)} · ${esc(e.weapon)}</b><small>${esc(e.actor)} → ${esc(e.victim)}</small></div><span class="distance">${e.distance} м</span></div>`).join('') || '<div class="markers empty">Боевые события не найдены</div>';
    resetView();
    renderRoutes();
    renderSquad()
}

async function loadMatch(id) {
    const player = $('custom-player').value.trim() || $('player').value;
    setStatus('Загружаю выбранный матч и телеметрию…');
    try {
        const r = await fetch('/api/dashboard', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({player, shard: $('shard').value, match_id: id})
        });
        const d = await r.json();
        if (!r.ok) throw Error(d.error || 'Ошибка запроса');
        renderMatch(d);
        const s = d.match_stats || {};
        $('map').scrollIntoView({behavior: 'smooth', block: 'start'});
        setStatus(`Матч выбран · ${s.kills || 0} убийств · ${s.damage || 0} урона · маршрутов: ${d.squad?.filter(x => x.points?.length > 1).length || 0} · зон: ${d.zone_pattern?.length || 0} · боевых линий: ${d.combat_lines?.length || 0}`)
    } catch (e) {
        setStatus(e.message, true)
    }
}

function renderHistory(data) {
    $('history-panel').classList.remove('hidden');
    $('player-title').textContent = data.player;
    $('match-list').innerHTML = data.matches.map(m => `<button class="match-item" data-id="${m.id}"><span class="match-date">${fmtDate(m.created_at)}</span><b>${mapName(m.map)}</b><small>${m.mode} · ${Math.floor((m.duration || 0) / 60)} мин · место ${m.rank}</small><strong>${m.kills} K / ${m.damage} DMG</strong></button>`).join('');
    document.querySelectorAll('.match-item').forEach(b => b.addEventListener('click', () => {
        document.querySelectorAll('.match-item').forEach(x => x.classList.remove('selected'));
        b.classList.add('selected');
        loadMatch(b.dataset.id)
    }));
    if (data.matches[0]) document.querySelector('.match-item').click()
}

$('routes').addEventListener('wheel', e => {
    e.preventDefault();
    const p = svgPoint(e);
    zoomAt(view.scale * (e.deltaY < 0 ? 1.2 : .83), p.x, p.y)
}, {passive: false});
$('routes').addEventListener('pointerdown', e => {
    mainCamera.invalidate();
    drag = {id: e.pointerId, x: e.clientX, y: e.clientY};
    e.currentTarget.setPointerCapture(e.pointerId)
});
$('routes').addEventListener('pointermove', e => {
    if (!drag) return;
    const current = svgPoint(e), previous = svgPoint({clientX: drag.x, clientY: drag.y});
    view.x += current.x - previous.x;
    view.y += current.y - previous.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    transform()
});
$('routes').addEventListener('pointerup', () => drag = null);
$('routes').addEventListener('pointercancel', () => drag = null);
$('zoom-in').addEventListener('click', () => zoomAt(view.scale * 1.35));
$('zoom-out').addEventListener('click', () => zoomAt(view.scale * .74));
$('zoom-reset').addEventListener('click', resetView);
$('player').addEventListener('change', () => { $('custom-player').value = '' });
$('custom-player').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        event.preventDefault();
        $('load').click()
    }
});
$('load').addEventListener('click', async () => {
    const player = $('custom-player').value.trim() || $('player').value;
    if (!player) return setStatus('Введите ник игрока.', true);
    $('load').disabled = true;
    $('load').textContent = 'Поиск…';
    setStatus('Ищу игрока и последние матчи…');
    try {
        const r = await fetch('/api/players', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({player, shard: $('shard').value})
        });
        const d = await r.json();
        if (!r.ok) throw Error(d.error || 'Ошибка запроса');
        renderHistory(d);
        setStatus(`Игрок найден · матчей в списке: ${d.matches.length}`)
    } catch (e) {
        setStatus(e.message, true)
    } finally {
        $('load').disabled = false;
        $('load').innerHTML = 'Найти игрока <span>↗</span>'
    }
});
transform();
document.fonts?.ready.then(measureCombatLabels);
