import unittest
from unittest.mock import patch

import pubg


class MapTelemetryTests(unittest.TestCase):
    def test_zone_phases_do_not_include_intermediate_samples(self):
        def state(phase, radius, x=100):
            return {'_T': 'LogGameStatePeriodic', 'common': {'isGame': phase},
                    'gameState': {'safetyZonePosition': {'x': x, 'y': 200}, 'safetyZoneRadius': radius}}
        events = [state(.5, 900), state(1, 800), state(1.5, 700),
                  state(1.5, 600), state(2, 500, 150), state(2.5, 400),
                  state(3, 250, 170)]
        zones = pubg.phase_zones(events)
        self.assertEqual([(z['phase'], z['radius']) for z in zones], [(1, 800), (2, 500), (3, 250)])

    def test_phase_prefers_fixed_warning_circle_to_moving_boundary(self):
        def state(phase, current, target):
            return {'_T': 'LogGameStatePeriodic', 'common': {'isGame': phase}, 'gameState': {
                'safetyZonePosition': {'x': 500, 'y': 500}, 'safetyZoneRadius': current,
                'poisonGasWarningPosition': {'x': 300, 'y': 300}, 'poisonGasWarningRadius': target}}
        zones = pubg.phase_zones([state(1, 581999, 192060), state(1.5, 450000, 192060),
                                  state(2, 192060, 105633), state(2.5, 180000, 105633)])
        self.assertEqual([(z['phase'], z['radius'], z['x']) for z in zones], [(1, 192060, 300), (2, 105633, 300)])

    def test_zone_phases_fall_back_to_phase_events_and_older_data(self):
        def state(radius):
            return {'_T': 'LogGameStatePeriodic', 'gameState': {'safetyZonePosition': {'x': 100, 'y': 200}, 'safetyZoneRadius': radius}}
        zones = pubg.phase_zones([{'_T': 'LogPhaseChange', 'phase': 1}, state(800), state(790),
                                  {'_T': 'LogPhaseChange', 'phase': 2}, state(500), state(490)])
        self.assertEqual([(z['phase'], z['radius']) for z in zones], [(1, 800), (2, 500)])
        self.assertEqual([z['radius'] for z in pubg.phase_zones([state(800), state(799), state(700), state(600), state(500), state(499)])], [800, 500])
        self.assertEqual(pubg.phase_zones([state(800), state(700), state(600)]), [])

    def test_terrain_interpolation_and_validation(self):
        with patch.object(pubg, 'TERRAIN_GRID', 2), patch.object(pubg, 'terrain_grid', return_value=bytes([127, 137, 147, 157])):
            self.assertEqual(pubg.terrain_height('Erangel_Main', 0, 0), 0)
            self.assertEqual(pubg.terrain_height('Erangel_Main', 816000, 816000), 62.4)
            self.assertEqual(pubg.terrain_height('Erangel_Main', 408000, 408000), 31.2)
            with self.assertRaises(ValueError):
                pubg.terrain_height('Erangel_Main', float('nan'), 0)

    def test_terrain_endpoint(self):
        with pubg.app.test_client() as client:
            for name in pubg.TERRAIN_MAPS:
                response = client.post('/api/terrain-height', json={'map': name, 'points': [{'x': 100000, 'y': 100000}, {'x': 90000, 'y': 90000}]})
                self.assertEqual(response.status_code, 200, name)
                self.assertEqual(len(response.json['heights']), 2)
                self.assertTrue(response.json['estimated'])
            self.assertEqual(client.post('/api/terrain-height', json={'map': 'Haven_Main', 'points': [{'x': 0, 'y': 0}]}).status_code, 422)
            self.assertEqual(client.post('/api/terrain-height', json={'map': 'Miramar_Main', 'points': [{'x': -1, 'y': 0}]}).status_code, 400)
            self.assertEqual(client.post('/api/terrain-height', json={'map': 'Chimera_Main', 'points': [{'x': 100, 'y': 100}]}).status_code, 200)

    def test_map_assets_and_extents(self):
        with pubg.app.test_client() as client:
            for raw, canonical in pubg.MAP_ALIASES.items():
                result = pubg.build_snapshot('test', {}, {'data': {'attributes': {'mapName': raw}}}, [])
                self.assertEqual(result['map'], canonical)
                with client.get(result['map_image']) as response:
                    self.assertEqual(response.status_code, 200)
            self.assertEqual(pubg.MAP_SIZES['Haven_Main'], 102000)
            self.assertEqual(pubg.MAP_SIZES['Paramo_Main'], 306000)

    def test_only_landed_drops_and_duplicate_ids(self):
        def event(kind, x):
            return {'_T': kind, 'itemPackage': {'itemPackageId': 'drop-1', 'location': {'x': x, 'y': 200}}}
        spawn = event('LogCarePackageSpawn', 1)
        land = event('LogCarePackageLand', 100)
        self.assertEqual(pubg.build_snapshot('test', {}, {}, [spawn])['airdrops'], [])
        result = pubg.build_snapshot('test', {}, {}, [spawn, land, land])
        self.assertEqual(len(result['airdrops']), 1)
        self.assertEqual(result['airdrops'][0]['x'], 100)

    def test_weapon_dictionary(self):
        self.assertEqual(pubg.clean_weapon_name('WeapAK47_C'), 'AKM')
        self.assertEqual(pubg.clean_weapon_name('WeapUnknown_C'), 'Unknown')

    def test_combat_weapon_and_distance(self):
        actor = {'name': 'test', 'accountId': 'a', 'teamId': 1,
                 'location': {'x': 10000, 'y': 10000, 'z': 0}}
        victim = {'name': 'target', 'accountId': 'b',
                  'location': {'x': 20000, 'y': 10000, 'z': 0}}
        events = [
            {'_T': 'LogPlayerMakeGroggy', 'attacker': actor, 'victim': victim,
             'damageCauserName': 'WeapAK47_C'},
            {'_T': 'LogPlayerKillV2', 'killer': actor, 'victim': victim,
             'killerDamageInfo': {'damageCauserName': 'WeapAK47_C'}},
        ]
        for event in events:
            result = pubg.combat_event(event, 1, {'a'}, {})
            self.assertEqual(result['weapon'], 'AKM')
            self.assertEqual(result['distance'], 100)
            self.assertEqual(result['to'], {'x': 20000, 'y': 10000})


if __name__ == '__main__':
    unittest.main()
