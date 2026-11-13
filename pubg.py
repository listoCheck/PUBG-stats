"""PUBG telemetry dashboard.

Run with:
    $env:PUBG_API_KEY = "your-key"
    python pubg.py

The official PUBG API is retrospective: the dashboard reads the newest
available match telemetry for a player, not a live game session.
"""

from __future__ import annotations

import json
import gzip
import math
import os
from functools import lru_cache
from typing import Any

import requests
from flask import Flask, jsonify, render_template, request
from werkzeug.middleware.proxy_fix import ProxyFix
from screenshot_recognition import recognize_screenshot, ScreenshotError, MAX_BYTES


def load_local_env() -> None:
    """Load a local .env without exposing the key to the browser."""
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.exists(env_path):
        return
    with open(env_path, encoding="utf-8") as env_file:
        for raw_line in env_file:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            os.environ.setdefault(name.strip(), value.strip().strip('"').strip("'"))


load_local_env()
app = Flask(__name__)
# nginx sets the trusted deployment prefix; local use remains at /.
app.wsgi_app = ProxyFix(app.wsgi_app, x_prefix=1)
app.config['MAX_CONTENT_LENGTH'] = MAX_BYTES
API_ROOT = "https://api.pubg.com"
API_ACCEPT = "application/vnd.api+json"
REQUEST_TIMEOUT = 30
MAP_ALIASES = {"Baltic_Main": "Erangel_Main", "Desert_Main": "Miramar_Main", "Savage_Main": "Sanhok_Main", "DihorOtok_Main": "Vikendi_Main", "Tiger_Main": "Taego_Main", "Neon_Main": "Rondo_Main", "Summerland_Main": "Karakin_Main", "Chimera_Main": "Paramo_Main", "Heaven_Main": "Haven_Main", "Kiki_Main": "Deston_Main"}
MAP_SIZES = {"Sanhok_Main": 408000, "Paramo_Main": 306000, "Karakin_Main": 204000, "Range_Main": 204000, "Haven_Main": 102000}
MAP_IMAGES = {name: f"/static/maps/{name}.webp" for name in ("Erangel_Main", "Miramar_Main", "Sanhok_Main", "Vikendi_Main", "Taego_Main", "Deston_Main", "Rondo_Main", "Karakin_Main", "Paramo_Main", "Haven_Main", "Range_Main")}
MAP_IMAGES.update({name: f"/static/maps/{name}.jpg" for name in ("Paramo_Main", "Miramar_Main")})
with open(os.path.join(os.path.dirname(__file__), "static", "weapon_names.json"), encoding="utf-8") as weapon_file:
    WEAPON_NAMES = json.load(weapon_file)

TERRAIN_MAPS = {f"{name.title()}_Main": name for name in (
    "erangel", "miramar", "sanhok", "vikendi", "taego", "deston", "rondo", "karakin", "paramo")}
TERRAIN_GRID = 2048


@lru_cache(maxsize=3)
def terrain_grid(map_name: str) -> bytes:
    path = os.path.join(os.path.dirname(__file__), "terrain", TERRAIN_MAPS[map_name] + ".u8.gz")
    with gzip.open(path, "rb") as terrain_file:
        values = terrain_file.read()
    if len(values) != TERRAIN_GRID ** 2:
        raise ValueError("Invalid terrain grid")
    return values


def terrain_height(map_name: str, x: float, y: float) -> float:
    extent = MAP_SIZES.get(map_name, 816000)
    if not math.isfinite(x) or not math.isfinite(y) or not (0 <= x <= extent and 0 <= y <= extent):
        raise ValueError("Coordinates outside map")
    values = terrain_grid(map_name)
    px, py = x / extent * (TERRAIN_GRID - 1), y / extent * (TERRAIN_GRID - 1)
    x0, y0 = int(px), int(py)
    x1, y1 = min(x0 + 1, TERRAIN_GRID - 1), min(y0 + 1, TERRAIN_GRID - 1)
    dx, dy = px - x0, py - y0
    top = values[y0 * TERRAIN_GRID + x0] * (1 - dx) + values[y0 * TERRAIN_GRID + x1] * dx
    bottom = values[y1 * TERRAIN_GRID + x0] * (1 - dx) + values[y1 * TERRAIN_GRID + x1] * dx
    # Community heightmap calibration; not a surveyed sea-level elevation.
    return round(((top * (1 - dy) + bottom * dy) - 127) * 2.08, 1)


@app.get("/weapons")
def weapons_page():
    return render_template("weapons.html")


@app.get("/secret-rooms")
def secret_rooms():
    return render_template("secret-rooms.html")


@app.post("/api/terrain-height")
def terrain_heights():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify(error="Некорректный запрос"), 400
    raw_map = str(payload.get("map", ""))
    map_name = MAP_ALIASES.get(raw_map, raw_map)
    if map_name not in TERRAIN_MAPS:
        return jsonify(error="Для этой карты нет данных высоты рельефа", supported=False), 422
    points = payload.get("points")
    if not isinstance(points, list) or not 1 <= len(points) <= 2:
        return jsonify(error="Укажите одну или две точки"), 400
    try:
        heights = [terrain_height(map_name, float(point["x"]), float(point["y"])) for point in points]
    except (KeyError, TypeError, ValueError, OverflowError):
        return jsonify(error="Некорректные координаты точек"), 400
    except (OSError, EOFError):
        return jsonify(error="Файл рельефа отсутствует или повреждён"), 503
    return jsonify(heights=heights, estimated=True, source="MingDMeng/mortarkiller",
                   grid_spacing_m=MAP_SIZES.get(map_name, 816000) / 100 / (TERRAIN_GRID - 1))



@app.post("/api/screenshot/recognize")
def recognize_map_screenshot():
    if request.content_length is None or request.content_length > MAX_BYTES:
        return jsonify(error="Размер скриншота должен быть не больше 12 МБ"), 413
    raw_map = request.args.get('map', '')
    name = MAP_ALIASES.get(raw_map, raw_map)
    color = request.args.get('color', '')
    if name not in MAP_IMAGES:
        return jsonify(error="Выберите карту и изображение"), 400
    path = os.path.join(os.path.dirname(__file__), 'static', 'maps', name + '.webp')
    try:
        result = recognize_screenshot(request.get_data(cache=False), color, path, MAP_SIZES.get(name, 816000))
    except ScreenshotError as exc:
        return jsonify(error=str(exc)), 422
    return jsonify(result)


@app.errorhandler(413)
def too_large(_error):
    return jsonify(error="Размер скриншота должен быть не больше 12 МБ"), 413


@app.after_request
def no_cache(response):
    response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


class PubgApiError(RuntimeError):
    pass


def api_get(path: str, api_key: str, **params: str) -> dict[str, Any]:
    response = requests.get(
        f"{API_ROOT}{path}",
        headers={"Authorization": f"Bearer {api_key}", "Accept": API_ACCEPT},
        params=params,
        timeout=REQUEST_TIMEOUT,
    )
    if not response.ok:
        try:
            detail = response.json().get("errors", [{}])[0].get("detail")
        except ValueError:
            detail = response.text[:200]
        raise PubgApiError(f"PUBG API {response.status_code}: {detail or 'request failed'}")
    return response.json()


def get_player(player_name: str, shard: str, api_key: str) -> dict[str, Any]:
    players = api_get(f"/shards/{shard}/players", api_key, **{"filter[playerNames]": player_name})
    data = players.get("data") or []
    if not data:
        raise PubgApiError(f"Игрок «{player_name}» не найден на платформе {shard}")
    return data[0]


def get_telemetry(match: dict[str, Any]) -> list[dict[str, Any]]:
    telemetry_url = next((item.get("attributes", {}).get("URL") for item in match.get("included", []) if item.get("type") == "asset"), None)
    if not telemetry_url:
        raise PubgApiError("В матче не найдена ссылка на телеметрию")
    response = requests.get(telemetry_url, timeout=REQUEST_TIMEOUT)
    response.raise_for_status()
    return response.json()


def match_summary(match: dict[str, Any], account_id: str, player_name: str | None = None) -> dict[str, Any]:
    attrs = match.get("data", {}).get("attributes", {})
    participant = next((x for x in match.get("included", []) if x.get("type") == "participant" and (x.get("relationships", {}).get("player", {}).get("data", {}).get("id") == account_id or x.get("attributes", {}).get("stats", {}).get("name", "").lower() == (player_name or "").lower())), None)
    stats = (participant or {}).get("attributes", {}).get("stats", {})
    raw_map = attrs.get("mapName", "Unknown")
    return {"id": match.get("data", {}).get("id"), "map": MAP_ALIASES.get(raw_map, raw_map), "mode": attrs.get("gameMode", "unknown"), "created_at": attrs.get("createdAt"), "duration": attrs.get("duration", 0), "rank": stats.get("winPlace", "—"), "kills": stats.get("kills", 0), "assists": stats.get("assists", 0), "damage": round(float(stats.get("damageDealt", 0) or 0), 1), "walk": round(float(stats.get("walkDistance", 0) or 0) / 1000, 2), "vehicle": round(float(stats.get("rideDistance", 0) or 0) / 1000, 2), "team_id": stats.get("teamId")}


def player_history(player_name: str, shard: str, api_key: str) -> dict[str, Any]:
    player = get_player(player_name, shard, api_key)
    account_id = player.get("id")
    relations = player.get("relationships", {}).get("matches", {}).get("data", [])[:12]
    matches = []
    for relation in relations:
        match = api_get(f"/shards/{shard}/matches/{relation['id']}", api_key)
        matches.append(match_summary(match, account_id, player.get("attributes", {}).get("name", player_name)))
    return {"player": player.get("attributes", {}).get("name", player_name), "account_id": account_id, "matches": matches}


def player_snapshot(player_name: str, shard: str, api_key: str, match_id: str | None = None) -> dict[str, Any]:
    player = get_player(player_name, shard, api_key)
    attrs = player.get("attributes", {})
    account_id = player.get("id")
    match_ids = (player.get("relationships", {}).get("matches", {}).get("data") or [])
    match_id = match_id or (match_ids[0]["id"] if match_ids else None)
    if not match_id:
        raise PubgApiError("У игрока пока нет доступных матчей")

    match = api_get(f"/shards/{shard}/matches/{match_id}", api_key)
    result = build_snapshot(player.get("attributes", {}).get("name", player_name), {**attrs, "accountId": account_id}, match, get_telemetry(match))
    result["match_stats"] = match_summary(match, account_id, player.get("attributes", {}).get("name", player_name))
    return result


def character_of(event: dict[str, Any]) -> dict[str, Any] | None:
    for key in ("character", "attacker", "victim", "killer", "finisher"):
        value = event.get(key)
        if isinstance(value, dict) and (value.get("accountId") or value.get("name")):
            return value
    return None


def is_player(character: dict[str, Any], player_name: str, account_id: str | None) -> bool:
    return character.get("accountId") == account_id or character.get("name", "").lower() == player_name.lower()


def character_location(character: dict[str, Any] | None) -> dict[str, float] | None:
    location = (character or {}).get("location") or {}
    if location.get("x") is None or location.get("y") is None:
        return None
    return {"x": float(location.get("x", 0)), "y": float(location.get("y", 0)), "z": float(location.get("z", 0))}


def phase_zones(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One safety circle per phase; infer distinct circles for older telemetry."""
    by_phase: dict[int, dict[str, Any]] = {}
    fallback: list[dict[str, Any]] = []
    current_phase = None
    previous_unphased = None
    for event in events:
        if event.get('_T') == 'LogPhaseChange':
            value = event.get('phase')
            if isinstance(value, (int, float)) and math.isfinite(value) and value >= 1:
                current_phase = int(value)
        if event.get('_T') != 'LogGameStatePeriodic':
            continue
        state = event.get('gameState') or {}
        # safetyZoneRadius is often the moving blue boundary; the warning
        # circle is the fixed destination for the current phase.
        warning = state.get('poisonGasWarningPosition') or {}
        warning_radius = state.get('poisonGasWarningRadius')
        has_warning = warning.get('x') is not None and warning.get('y') is not None and warning_radius
        if has_warning:
            position, radius = warning, warning_radius
        else:
            position, radius = state.get('safetyZonePosition') or {}, state.get('safetyZoneRadius')
        try:
            x, y, radius = float(position['x']), float(position['y']), float(radius)
            if not all(math.isfinite(v) for v in (x, y, radius)) or radius <= 0:
                continue
        except (KeyError, TypeError, ValueError):
            continue
        circle = {'x': round(x), 'y': round(y), 'radius': round(radius),
                  'elapsed': event.get('elapsedTime', state.get('elapsedTime'))}
        raw_phase = (event.get('common') or {}).get('isGame')
        if isinstance(raw_phase, (int, float)) and math.isfinite(raw_phase):
            # Before the first circle appears, 0.1 and 0.5 are not phases.
            phase = math.floor(raw_phase) if raw_phase >= 1 else None
        else:
            phase = current_phase
        if phase:
            circle['phase'] = phase
            by_phase.setdefault(phase, circle)
        elif raw_phase is None:
            # Without a phase number, only trust a fixed target circle or a
            # blue boundary that stayed still across consecutive samples.
            stable = has_warning or (previous_unphased is not None and
                abs(radius - previous_unphased['radius']) <= radius * 0.01 and
                math.hypot(x - previous_unphased['x'], y - previous_unphased['y']) <= radius * 0.01)
            candidate = circle if has_warning else previous_unphased
            previous = fallback[-1] if fallback else None
            if stable and (previous is None or
                abs(candidate['radius'] - previous['radius']) > previous['radius'] * 0.03 or
                math.hypot(candidate['x'] - previous['x'], candidate['y'] - previous['y']) > previous['radius'] * 0.03):
                fallback.append(candidate)
            previous_unphased = circle
    if by_phase:
        return [by_phase[key] for key in sorted(by_phase)]
    return fallback


def clean_weapon_name(value: Any) -> str:
    if value in WEAPON_NAMES:
        return WEAPON_NAMES[value]
    name = str(value or "Оружие не указано")
    for prefix in ("Item_Weapon_", "Weapon_", "Weap"):
        if name.startswith(prefix):
            name = name[len(prefix):]
            break
    return name.replace("_C", "").replace("_", " ").strip() or "Оружие не указано"


def combat_event(event: dict[str, Any], team_id: int | None, team_accounts: set[str], last_locations: dict[str, dict[str, float]]) -> dict[str, Any] | None:
    event_type = event.get("_T", "")
    if event_type == "LogPlayerMakeGroggy":
        attacker, victim = event.get("attacker"), event.get("victim")
        weapon = event.get("damageCauserName") or "Оружие не указано"
        distance = event.get("distance")
        kind = "НОК"
    elif event_type == "LogPlayerKillV2":
        attacker, victim = event.get("killer") or event.get("finisher") or event.get("dBNOMaker"), event.get("victim")
        damage = event.get("killerDamageInfo") or event.get("finishDamageInfo") or event.get("dBNODamageInfo") or {}
        weapon = damage.get("damageCauserName") or "Оружие не указано"
        distance = damage.get("distance")
        kind = "УБИЙСТВО"
    elif event_type == "LogPlayerKill":
        attacker, victim = event.get("killer"), event.get("victim")
        weapon = event.get("damageCauserName") or "Оружие не указано"
        distance = event.get("distance")
        kind = "УБИЙСТВО"
    else:
        return None
    attacker_id = (attacker or {}).get("accountId")
    if not attacker or not victim or (team_id is not None and attacker.get("teamId") not in (None, team_id) and attacker_id not in team_accounts):
        return None
    start, finish = character_location(attacker), character_location(victim)
    if not start:
        start = last_locations.get(attacker_id or attacker.get("name"))
    if not finish:
        finish = last_locations.get(victim.get("accountId") or victim.get("name"))
    if not start or not finish:
        return None
    # Location coordinates are centimeters. Recalculate from the two
    # locations so the UI always receives meters, regardless of the unit used
    # by an optional distance field in the event.
    if start and finish:
        distance = math.sqrt(sum((start[key] - finish[key]) ** 2 for key in ("x", "y", "z"))) / 100
    elif distance is not None and float(distance) > 1000:
        distance = float(distance) / 100
    return {"kind": kind, "actor": attacker.get("name", "Без имени"), "victim": victim.get("name", "Цель"), "weapon": clean_weapon_name(weapon), "distance": round(float(distance), 1), "from": {"x": round(start["x"]), "y": round(start["y"])}, "to": {"x": round(finish["x"]), "y": round(finish["y"])}}


def build_snapshot(player_name: str, player_attrs: dict[str, Any], match: dict[str, Any], events: list[dict[str, Any]]) -> dict[str, Any]:
    account_id = player_attrs.get("accountId")
    map_name = match.get("data", {}).get("attributes", {}).get("mapName", "Unknown map")
    player_team_id = None
    paths: dict[str, dict[str, Any]] = {}
    flight_paths: dict[str, list[dict[str, int]]] = {}
    last_locations: dict[str, dict[str, float]] = {}
    combat_lines = []
    airdrops = {}

    # First find the player's team. This lets us include squadmates even if
    # their first position event appears before the player's first event.
    for event in events:
        character = character_of(event)
        if event.get("_T") == "LogPlayerPosition" and character and character.get("location") and is_player(character, player_name, account_id):
            player_team_id = character.get("teamId")
            break
    team_accounts = set()
    for event in events:
        character = character_of(event)
        if event.get("_T") == "LogPlayerPosition" and character and character.get("teamId") == player_team_id:
            member_id = character.get("accountId") or character.get("name")
            if member_id:
                team_accounts.add(member_id)
    landing_index = next((index for index, event in enumerate(events) if event.get("_T") == "LogParachuteLanding" and ((event.get("character") or {}).get("accountId") in team_accounts or (event.get("character") or {}).get("name") == player_name)), None)

    for event_index, event in enumerate(events):
        character = character_of(event)
        if event.get("_T") == "LogPlayerPosition" and character and character.get("location"):
            member_id = character.get("accountId") or character.get("name")
            common_phase = (event.get("common") or {}).get("isGame")
            before_landing = landing_index is not None and event_index < landing_index
            before_game = landing_index is None and common_phase is not None and common_phase < 1
            is_squad_member = member_id and ((player_team_id is not None and character.get("teamId") == player_team_id) or member_id == account_id)
            if is_squad_member:
                point = {"x": round(float(character["location"].get("x", 0))), "y": round(float(character["location"].get("y", 0)))}
                if point["x"] != 0 or point["y"] != 0:
                    # PUBG common.isGame == 0.1 means the character is on the airplane.
                    in_airplane = common_phase is not None and 0.05 <= float(common_phase) <= 0.2
                    if (before_landing or before_game) and in_airplane:
                        flight_paths.setdefault(member_id, []).append(point)
                    elif not before_landing and not before_game:
                        route = paths.setdefault(member_id, {"name": character.get("name") or "Без имени", "account_id": character.get("accountId"), "points": []})
                        route["points"].append(point)
                last_locations[member_id] = character_location(character)
        if event.get("_T") == "LogMatchStart":
            map_name = event.get("mapName") or map_name

        if event.get("_T") == "LogCarePackageLand":
            package = event.get("itemPackage") or {}
            location = character_location(package)
            if location:
                key = package.get("itemPackageId") or (location["x"], location["y"])
                airdrops[key] = {"id": str(key), **location, "landed_at": event.get("_D")}

        combat = combat_event(event, player_team_id, team_accounts, last_locations)
        if combat:
            combat_lines.append(combat)

    squad_paths = []
    for route in paths.values():
        route["points"] = [point for point in route["points"] if point["x"] != 0 or point["y"] != 0]
        step = max(1, math.ceil(len(route["points"]) / 350))
        route["points"] = route["points"][::step]
        squad_paths.append(route)
    if not squad_paths:
        squad_paths = [{"name": player_name, "points": []}]
    flight_path = flight_paths.get(account_id) or next(iter(flight_paths.values()), [])
    flight_step = max(1, math.ceil(len(flight_path) / 350))
    map_name = MAP_ALIASES.get(map_name, map_name)
    map_size = MAP_SIZES.get(map_name, 816000)
    return {
        "player": player_name,
        "match_id": next((x.get("id") for x in (match.get("data", {}),) if isinstance(x, dict)), None),
        "map": map_name,
        "map_image": MAP_IMAGES.get(map_name),
        "map_size": map_size,
        "squad": squad_paths,
        "flight_path": flight_path[::flight_step],
        "zone_pattern": phase_zones(events),
        "combat_lines": combat_lines,
        "airdrops": list(airdrops.values()),
        "telemetry_events": len(events),
        "note": "Маршруты сквада и паттерн безопасной зоны восстановлены из телеметрии выбранного матча.",
    }


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/favicon.ico")
def favicon():
    return app.send_static_file("favicon.ico")


@app.post("/api/players")
def players():
    payload = request.get_json(silent=True) or {}
    player_name = str(payload.get("player", "")).strip()
    shard = str(payload.get("shard", "steam")).strip() or "steam"
    api_key = os.getenv("PUBG_API_KEY", "").strip()
    if not player_name:
        return jsonify(error="Укажите ник игрока"), 400
    if not api_key or api_key.startswith("вставьте-") or api_key == "your-key":
        return jsonify(error="Не задан PUBG_API_KEY. Укажите новый ключ в .env или переменной окружения."), 500
    try:
        return jsonify(player_history(player_name, shard, api_key))
    except (PubgApiError, requests.RequestException) as exc:
        return jsonify(error=str(exc)), 502


@app.post("/api/dashboard")
def dashboard():
    payload = request.get_json(silent=True) or {}
    player_name = str(payload.get("player", "")).strip()
    shard = str(payload.get("shard", "steam")).strip() or "steam"
    api_key = os.getenv("PUBG_API_KEY", "").strip()
    if not player_name:
        return jsonify(error="Укажите имя игрока"), 400
    if not api_key or api_key.startswith("вставьте-") or api_key == "your-key":
        return jsonify(error="Не задан PUBG_API_KEY. Укажите новый ключ в .env или переменной окружения."), 500
    try:
        return jsonify(player_snapshot(player_name, shard, api_key, str(payload.get("match_id") or "") or None))
    except (PubgApiError, requests.RequestException) as exc:
        return jsonify(error=str(exc)), 502


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=True)
