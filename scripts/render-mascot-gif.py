#!/usr/bin/env python3
# scripts/render-mascot-gif.py — [2026-10-19 sticker-anim] Lottie do mascote → GIF
# animado (loop) p/ a lista NATIVA de mensagens (ImageIO/Glide animam GIF; o
# nativo não tem Lottie). Gera public/stickers/<pose>.gif ao lado do .json.
#   python3 -m venv /tmp/rl && /tmp/rl/bin/pip install rlottie-python Pillow
#   /tmp/rl/bin/python scripts/render-mascot-gif.py public/stickers/chatyy-aceno.json public/stickers/chatyy-aceno.gif
# Nova pose → rodar isto, copiar p/ /var/www/mail/stickers/ (US/BR/BR2/EU) e
# acrescentar a pose em _MASCOT_GIF_POSES (components/chat/nativeThreadList.js).
# 240 px / 20 fps: ~11 MB decodificado no iOS (UIImage.animatedImage).
import sys
from rlottie_python import LottieAnimation
from PIL import Image
src, out_gif = sys.argv[1:3]
a = LottieAnimation.from_file(src)
total = a.lottie_animation_get_totalframe(); fr = a.lottie_animation_get_framerate()
FPS = 20; SIZE = 240
n = int(round(total / fr * FPS))
frames = []
for i in range(n):
    idx = int(round(i * fr / FPS)) % total
    frames.append(a.render_pillow_frame(frame_num=idx, width=SIZE, height=SIZE).convert('RGBA'))
dur = int(1000 / FPS)
# GIF: alfa binário (limiar), transparente = índice reservado
gf = []
for f in frames:
    alpha = f.getchannel('A')
    rgb = Image.new('RGB', f.size, (255, 255, 255)); rgb.paste(f, mask=alpha)
    p = rgb.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    pal = p.getpalette()[:765]; pal += [0, 0, 0] * (256 - len(pal)//3)
    p.putpalette(pal)
    mask = alpha.point(lambda v: 255 if v < 110 else 0)
    p.paste(255, mask=mask)
    p.info['transparency'] = 255
    gf.append(p)
gf[0].save(out_gif, save_all=True, append_images=gf[1:], duration=dur, loop=0, transparency=255, disposal=2, optimize=True)
print(total, fr, n)
