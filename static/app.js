const $ = id => document.getElementById(id);
let state = {mapSize: 816000, squad: [], zones: [], combat: [], mapImage: ''};
let view = {scale: 1, x: 0, y: 0};
let drag = null;
const colors = ['#62d4cf', '#f0a24b', '#f27568', '#b490ff'];
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

function mapName(name) {
    return ({
        Erangel_Main: 'Эрангель',
        Miramar_Main: 'Мирамар',
        Sanhok_Main: 'Санок',
        Vikendi_Main: 'Викенди',
        Taego_Main: 'Тэго',
        Deston_Main: 'Дэстон',
        Rondo_Main: 'Рондо',
        Karakin_Main: 'Каракин',
        Paramo_Main: 'Парамо',
        Haven_Main: 'Хейвен'
    })[name] || name
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

function transform() {
    const g = $('viewport');
    g.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.scale})`);
    document.querySelectorAll('.combat-label-svg').forEach(label => {
        label.style.fontSize = `${2.2 / view.scale}px`
    });
    document.querySelectorAll('.squad-route').forEach(line => line.style.strokeWidth = (.55 / view.scale));
    document.querySelectorAll('.combat-line').forEach(line => line.style.strokeWidth = (.75 / view.scale));
    document.querySelectorAll('.safe-zone').forEach(zone => zone.style.strokeWidth = ((zone.classList.contains('last') ? .8 : .35) / view.scale));
    document.querySelectorAll('.combat-dot').forEach(dot => dot.setAttribute('r', 1.2 / view.scale))
}

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

function svgPoint(event) {
    const r = $('routes').getBoundingClientRect();
    return {x: (event.clientX - r.left) / r.width * 100, y: (event.clientY - r.top) / r.height * 100}
}

function clearGroup(id) {
    $(id).replaceChildren()
}

function placeCombatLabel(mx, my, text, seed, placed) {
    const candidates = [[seed, seed], [seed, seed - 4], [seed, seed + 4], [seed - 6, seed], [seed + 6, seed], [seed - 6, seed - 4], [seed + 6, seed + 4], [seed - 9, seed + 6], [seed + 9, seed - 6]];
    const width = Math.max(7, text.length * .72), height = 2.5;
    for (const [dx, dy] of candidates) {
        const x = mx + dx, y = my + dy,
            box = {left: x - width / 2, right: x + width / 2, top: y - height, bottom: y + height};
        if (!placed.some(p => box.left < p.right && box.right > p.left && box.top < p.bottom && box.bottom > p.top)) {
            placed.push(box);
            return {x, y}
        }
    }
    const fallback = {x: mx + seed, y: my + seed + placed.length * 3};
    placed.push({
        left: fallback.x - width / 2,
        right: fallback.x + width / 2,
        top: fallback.y - height,
        bottom: fallback.y + height
    });
    return fallback
}

function resolveLabelCollisions() {
    const labels = [...document.querySelectorAll('.combat-label-svg')],
        branches = [...document.querySelectorAll('.combat-branch')], placed = [], s = state.mapSize || 816000;
    labels.forEach((label, i) => {
        const event = state.combat[i];
        if (!event) return;
        const x = (event.from.x + event.to.x) / 2 / s * 100, y = (event.from.y + event.to.y) / 2 / s * 100,
            text = label.textContent || '', pos = placeCombatLabel(x, y, text, 0, placed);
        label.setAttribute('x', pos.x);
        label.setAttribute('y', pos.y);
        if (branches[i]) {
            branches[i].setAttribute('x2', pos.x);
            branches[i].setAttribute('y2', pos.y)
        }
    })
}

function renderCombatSummary(s) {
    const root = $('combat-summary');
    clearGroup('combat-summary');
    const groups = [];
    state.combat.forEach(event => {
        const x = event.to.x / s * 100, y = event.to.y / s * 100;
        let group = groups.find(item => Math.hypot(item.x - x, item.y - y) < 1.2);
        if (!group) {
            group = {x, y, events: []};
            groups.push(group)
        }
        group.events.push(event)
    });
    groups.forEach(group => {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('class', 'combat-summary-group');
        const marker = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        marker.setAttribute('cx', group.x);
        marker.setAttribute('cy', group.y);
        marker.setAttribute('r', '1.4');
        marker.setAttribute('class', 'combat-summary-marker');
        g.appendChild(marker);
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', group.x + 1.8);
        text.setAttribute('y', group.y - 1);
        text.setAttribute('class', 'combat-summary-text');
        group.events.forEach((event, index) => {
            const row = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
            row.setAttribute('x', group.x + 1.8);
            row.setAttribute('dy', index === 0 ? '0' : '2.5');
            row.textContent = `${event.kind} · ${event.weapon} · ${event.distance} м`;
            text.appendChild(row)
        });
        g.appendChild(text);
        root.appendChild(g)
    })
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
    image.setAttribute('href', state.mapImage || '');
    image.setAttribute('xlink:href', state.mapImage || '');
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
        zones.appendChild(c)
    });
    state.squad.forEach((m, i) => {
        if (m.points.length < 2) return;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        line.setAttribute('points', m.points.map(p => `${p.x / s * 100},${p.y / s * 100}`).join(' '));
        line.setAttribute('stroke', colors[i % 4]);
        line.setAttribute('class', 'squad-route');
        routes.appendChild(line)
    });
    const clusters = {};
    state.combat.forEach(e => {
        const key = `${Math.round(e.from.x / 100)},${Math.round(e.from.y / 100)}`;
        (clusters[key] ??= []).push(e)
    });
    const clusterIndex = {};
    state.combat.forEach(e => {
        const x1 = e.from.x / s * 100, y1 = e.from.y / s * 100, x2 = e.to.x / s * 100, y2 = e.to.y / s * 100,
            mx = (x1 + x2) / 2, my = (y1 + y2) / 2, key = `${Math.round(e.from.x / 100)},${Math.round(e.from.y / 100)}`,
            group = clusters[key], idx = clusterIndex[key] || 0;
        clusterIndex[key] = idx + 1;
        const offset = (idx - (group.length - 1) / 2) * 3;
        const labelX = mx + offset, labelY = my + offset;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', x1);
        line.setAttribute('y1', y1);
        line.setAttribute('x2', x2);
        line.setAttribute('y2', y2);
        line.setAttribute('class', 'combat-line');
        combat.appendChild(line);
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', x2);
        circle.setAttribute('cy', y2);
        circle.setAttribute('r', '1.2');
        circle.setAttribute('class', 'combat-dot');
        combat.appendChild(circle);
        if (group.length > 1) {
            const branch = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            branch.setAttribute('x1', mx);
            branch.setAttribute('y1', my);
            branch.setAttribute('x2', labelX);
            branch.setAttribute('y2', labelY);
            branch.setAttribute('class', 'combat-branch');
            combat.appendChild(branch)
        }
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', labelX);
        label.setAttribute('y', labelY);
        label.setAttribute('class', 'combat-label-svg');
        label.textContent = `${e.kind} · ${e.weapon} · ${e.distance} м`;
        combat.appendChild(label)
    });
    transform()
}

function renderSquad() {
    const box = $('squad');
    box.className = 'markers';
    box.innerHTML = state.squad.map((m, i) => `<div class="marker-row"><div><b style="color:${playerColor(m.name, i)}">${esc(m.name)}</b><small>${m.points.length} точек маршрута</small></div></div>`).join('') || '<div class="markers empty">Нет данных о маршруте</div>'
}

function renderMatch(d) {
    state.mapSize = d.map_size;
    state.mapImage = d.map_image || '';
    state.squad = d.squad || [];
    state.flight = d.flight_path || [];
    state.zones = d.zone_pattern || [];
    state.combat = d.combat_lines || [];
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
    const player = $('player').value.trim();
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
    drag = {id: e.pointerId, x: e.clientX, y: e.clientY};
    e.currentTarget.setPointerCapture(e.pointerId)
});
$('routes').addEventListener('pointermove', e => {
    if (!drag) return;
    const r = $('routes').getBoundingClientRect();
    view.x += (e.clientX - drag.x) / r.width * 100;
    view.y += (e.clientY - drag.y) / r.height * 100;
    drag.x = e.clientX;
    drag.y = e.clientY;
    transform()
});
$('routes').addEventListener('pointerup', () => drag = null);
$('routes').addEventListener('pointercancel', () => drag = null);
$('zoom-in').addEventListener('click', () => zoomAt(view.scale * 1.35));
$('zoom-out').addEventListener('click', () => zoomAt(view.scale * .74));
$('zoom-reset').addEventListener('click', resetView);
$('load').addEventListener('click', async () => {
    const player = $('player').value.trim();
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
const baseTransform = transform;
transform = () => {
    renderFlightPath(state.mapSize || 816000);
    renderCombatSummary(state.mapSize || 816000);
    baseTransform();
    document.querySelectorAll('.squad-route').forEach((line, i) => line.style.stroke = playerColor(state.squad[i]?.name, i));
    document.querySelectorAll('.flight-line').forEach(line => line.style.strokeWidth = .6 / view.scale);
    document.querySelectorAll('.combat-summary-text').forEach(label => label.style.fontSize = `${2.2 / view.scale}px`);
    document.querySelectorAll('.combat-summary-marker').forEach(marker => {
        marker.setAttribute('r', 1.4 / view.scale);
        marker.style.strokeWidth = .25 / view.scale
    })
};
