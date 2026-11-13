import io
import unittest
from pathlib import Path

from PIL import Image, ImageDraw
import numpy as np

import pubg
from screenshot_recognition import ScreenshotError, color_candidates, recognize_screenshot


class ScreenshotRecognitionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.map_path = str(Path('static/maps/Erangel_Main.webp').resolve())
        source = Image.open(cls.map_path).convert('RGB').resize((2048, 2048))
        cls.base = Image.new('RGB', (1440, 1000), '#151c20')
        cls.base.paste(source.crop((500, 600, 1500, 1400)), (220, 100))
        cls.colors = {'yellow':'#ffea00', 'orange':'#ff8000', 'blue':'#0080ff', 'green':'#00e040'}

    def image(self, color):
        image = self.base.copy()
        draw = ImageDraw.Draw(image)
        fill = self.colors[color]
        draw.ellipse((609,489,631,511), fill=fill, outline='white', width=2)
        draw.polygon([(820,340),(832,350),(830,365),(820,380),(810,365),(808,350)], fill=fill, outline='white', width=2)
        output = io.BytesIO(); image.save(output, format='PNG')
        return output.getvalue()

    def test_alignment_and_color_detection_at_multiple_squad_colors(self):
        for color in self.colors:
            with self.subTest(color=color):
                result = recognize_screenshot(self.image(color), color, self.map_path, 816000)
                self.assertGreaterEqual(result['inliers'], 12)
                matrix = result['transform']
                # Screenshot pixel (620,500) corresponds to reference pixel (900,1000).
                x = matrix[0]*620 + matrix[1]*500 + matrix[2]
                y = matrix[3]*620 + matrix[4]*500 + matrix[5]
                error_m = ((x - 900/2048*816000)**2 + (y - 1000/2048*816000)**2)**.5 / 100
                self.assertLess(error_m, 10)
                self.assertTrue(any(abs(c['x']-620)<5 and abs(c['y']-500)<5 for c in result['candidates']))
                self.assertTrue(any(abs(c['x']-820)<5 and abs(c['tip_y']-380)<8 for c in result['candidates']))

    def test_bad_images_and_wrong_map_are_rejected(self):
        with self.assertRaises(ScreenshotError): recognize_screenshot(b'not an image', 'yellow', self.map_path, 816000)
        with self.assertRaises(ScreenshotError): recognize_screenshot(self.image('yellow'), 'purple', self.map_path, 816000)
        with self.assertRaises(ScreenshotError):
            recognize_screenshot(self.image('yellow'), 'yellow', str(Path('static/maps/Miramar_Main.webp').resolve()), 816000)
        with pubg.app.test_client() as client:
            self.assertEqual(client.post('/api/screenshot/recognize?map=../foo&color=yellow', data=b'bad').status_code, 400)
            self.assertEqual(client.post('/api/screenshot/recognize?map=Erangel_Main&color=yellow', data=b'bad').status_code, 422)


if __name__ == '__main__':
    unittest.main()
