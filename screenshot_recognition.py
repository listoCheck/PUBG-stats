"""Register a PUBG screenshot to the selected map and suggest colored markers.

The returned transform maps original screenshot pixels to telemetry centimeters.
The input is decoded in memory only; no uploaded image is written to disk.
"""
from __future__ import annotations

import io
import math
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

cv2.setNumThreads(1)
MAX_BYTES = 12 * 1024 * 1024
MAX_PIXELS = 20_000_000
FEATURE_SIZE = 2048
COLORS = {
    'yellow': (20, 39), 'orange': (3, 19),
    'green': (40, 88), 'blue': (90, 135),
}


class ScreenshotError(ValueError):
    pass


@lru_cache(maxsize=3)
def map_features(path: str):
    gray = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise ScreenshotError('Изображение выбранной карты не найдено')
    gray = cv2.resize(gray, (FEATURE_SIZE, FEATURE_SIZE), interpolation=cv2.INTER_AREA)
    orb = cv2.ORB_create(nfeatures=12000, scaleFactor=1.2, nlevels=8, fastThreshold=7)
    points, descriptors = orb.detectAndCompute(gray, None)
    if descriptors is None:
        raise ScreenshotError('Не удалось подготовить выбранную карту')
    return np.array([p.pt for p in points], dtype=np.float32), descriptors


def decode_image(data: bytes):
    if not data or len(data) > MAX_BYTES:
        raise ScreenshotError('Размер изображения должен быть не больше 12 МБ')
    try:
        with Image.open(io.BytesIO(data)) as source:
            if source.format not in ('PNG', 'JPEG', 'WEBP'):
                raise ScreenshotError('Поддерживаются PNG, JPEG и WebP')
            width, height = source.size
            if width < 200 or height < 200 or width * height > MAX_PIXELS:
                raise ScreenshotError('Разрешение изображения должно быть от 200×200 до 20 мегапикселей')
            source = ImageOps.exif_transpose(source)
            return np.asarray(source.convert('RGB'))
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ScreenshotError('Не удалось прочитать изображение') from exc


def color_candidates(rgb: np.ndarray, color: str):
    if color not in COLORS:
        raise ScreenshotError('Выберите один из четырёх цветов')
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    lo, hi = COLORS[color]
    mask = cv2.inRange(hsv, (lo, 145, 175), (hi, 255, 255))
    # Connect anti-aliased fragments while keeping nearby independent icons separate.
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    count, _, stats, centers = cv2.connectedComponentsWithStats(mask, 8)
    height, width = mask.shape
    out = []
    for index in range(1, count):
        x, y, w, h, area = (int(value) for value in stats[index])
        if area < 10 or w < 4 or h < 4 or w > width * .055 or h > height * .075:
            continue
        if area > width * height * .002 or max(w / h, h / w) > 4:
            continue
        # Outlined/hollow pins and compact player symbols both remain candidates;
        # their meaning is confirmed by the user rather than guessed from color.
        out.append({'x': float(centers[index][0]), 'y': float(centers[index][1]),
                    'w': w, 'h': h, 'bottom': y + h - 1, 'area': area})
    return sorted(out, key=lambda item: item['area'], reverse=True)[:80]


def recognize_screenshot(data: bytes, color: str, map_path: str, extent: int):
    if color not in COLORS:
        raise ScreenshotError('Выберите один из четырёх цветов')
    rgb = decode_image(data)
    orig_h, orig_w = rgb.shape[:2]
    scale = min(1.0, 2000 / max(orig_w, orig_h))
    if scale < 1:
        rgb = cv2.resize(rgb, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    orb = cv2.ORB_create(nfeatures=12000, scaleFactor=1.2, nlevels=8, fastThreshold=7)
    shot_points, shot_descriptors = orb.detectAndCompute(gray, None)
    ref_points, ref_descriptors = map_features(map_path)
    if shot_descriptors is None or len(shot_points) < 25:
        raise ScreenshotError('На скриншоте недостаточно деталей карты. Откройте карту и сделайте новый снимок.')
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    pairs = matcher.knnMatch(shot_descriptors, ref_descriptors, k=2)
    good = [a for pair in pairs if len(pair) == 2 for a, b in [pair] if a.distance < .72 * b.distance]
    if len(good) < 14:
        raise ScreenshotError('Не удалось сопоставить скриншот с выбранной картой. Проверьте карту и масштаб.')
    source = np.float32([shot_points[m.queryIdx].pt for m in good])
    dest = np.float32([ref_points[m.trainIdx] for m in good])
    affine, inlier_mask = cv2.estimateAffinePartial2D(source, dest, method=cv2.RANSAC,
        ransacReprojThreshold=4, maxIters=6000, confidence=.999, refineIters=20)
    if affine is None or inlier_mask is None:
        raise ScreenshotError('Не удалось определить масштаб карты на скриншоте')
    valid = inlier_mask.ravel().astype(bool)
    count = int(valid.sum())
    inlier_points = source[valid]
    hull_area = cv2.contourArea(cv2.convexHull(inlier_points)) if count >= 3 else 0
    mapped = cv2.transform(inlier_points.reshape(-1, 1, 2), affine).reshape(-1, 2)
    error = float(np.median(np.linalg.norm(mapped - dest[valid], axis=1))) if count else float('inf')
    rotation = abs(math.degrees(math.atan2(float(affine[1, 0]), float(affine[0, 0]))))
    factor = math.hypot(float(affine[0, 0]), float(affine[1, 0]))
    if (count < 12 or count / len(good) < .32 or error > 3.5 or rotation > 2 or
        not .08 <= factor <= 20 or hull_area < rgb.shape[0] * rgb.shape[1] * .002):
        raise ScreenshotError('Совпадение с картой недостаточно надёжное. Выберите правильную карту и повторите снимок.')
    # x/y in original screenshot pixels -> x/y in PUBG centimeters.
    coefficient = extent / FEATURE_SIZE
    transform = [float(affine[0, 0] * scale * coefficient), float(affine[0, 1] * scale * coefficient),
                 float(affine[0, 2] * coefficient), float(affine[1, 0] * scale * coefficient),
                 float(affine[1, 1] * scale * coefficient), float(affine[1, 2] * coefficient)]
    found = []
    for item in color_candidates(rgb, color):
        sx, sy = item['x'], item['y']
        mx = (affine[0, 0] * sx + affine[0, 1] * sy + affine[0, 2]) * coefficient
        my = (affine[1, 0] * sx + affine[1, 1] * sy + affine[1, 2]) * coefficient
        if 0 <= mx <= extent and 0 <= my <= extent:
            found.append({'x': round(sx / scale, 1), 'y': round(sy / scale, 1),
                          'width': round(item['w'] / scale, 1), 'height': round(item['h'] / scale, 1),
                          'tip_y': round(item['bottom'] / scale, 1)})
    return {'width': orig_w, 'height': orig_h, 'transform': transform,
            'candidates': found, 'inliers': count, 'estimated': True}
