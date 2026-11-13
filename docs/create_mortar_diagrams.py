"""Generate the README diagrams using the actual JavaScript aiming model.

Run from the repository root with Node.js, Pillow and matplotlib installed:
    python docs/create_mortar_diagrams.py
"""
from pathlib import Path
import json
import math
import subprocess
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs' / 'images'
OUT.mkdir(parents=True, exist_ok=True)
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':11,'figure.facecolor':'#10171e',
                     'axes.facecolor':'#19232d','axes.labelcolor':'#dce8ef',
                     'text.color':'#edf4f6','xtick.color':'#b5c5cc','ytick.color':'#b5c5cc',
                     'axes.edgecolor':'#6a7a80','savefig.facecolor':'#10171e'})

# Two points 500 m apart on the existing Erangel image. Elevation values below
# are hypothetical: the image supplies geographic context, not terrain samples.
image = Image.open(ROOT / 'static' / 'maps' / 'Erangel_Main.webp').convert('RGB')
fig, ax = plt.subplots(figsize=(12, 6), dpi=150, layout='constrained')
ax.imshow(image, extent=(0, 8160, 8160, 0), interpolation='antialiased')
a, b = (3650, 3990), (4150, 3990)
ax.set_xlim(3420, 4380); ax.set_ylim(4320, 3660)
ax.plot([a[0], b[0]], [a[1], b[1]], color='#111820', linewidth=6, zorder=3)
ax.plot([a[0], b[0]], [a[1], b[1]], color='#ffd36c', linewidth=2.5, zorder=4)
for xy, color in [(a,'#62d4cf'),(b,'#f27568')]:
    ax.scatter(*xy, s=250, c=color, edgecolors='white', linewidths=2, zorder=5)
ax.annotate('A · миномёт', a, xytext=(-13, 20), textcoords='offset points', ha='right',
            color='white', fontsize=13, weight='bold', bbox=dict(boxstyle='round,pad=.4',fc='#101820',alpha=.9,ec='none'))
ax.annotate('B · цель', b, xytext=(13, 20), textcoords='offset points', ha='left',
            color='white', fontsize=13, weight='bold', bbox=dict(boxstyle='round,pad=.4',fc='#101820',alpha=.9,ec='none'))
ax.text(3900, 3960, '500 м по горизонтали', ha='center', va='bottom', fontsize=14, weight='bold',
        color='#ffd36c', bbox=dict(boxstyle='round,pad=.4',fc='#101820',alpha=.92,ec='none'))
ax.set_axis_off()
ax.set_title('1. Вид сверху: выбираем точки A и B',loc='left',fontsize=18,weight='bold',pad=14)
fig.savefig(OUT/'mortar-map.png',bbox_inches='tight'); plt.close(fig)

# Use the production calculator to choose settings, then replay its descending
# integration. The rising segment is explicitly a diagram, not a simulation.
js = "const fs=require('fs'),vm=require('vm');const c=vm.createContext({});vm.runInContext(fs.readFileSync('static/mortar.js','utf8').split('(() =>')[0],c);console.log(JSON.stringify([c.calculateMortarAim(500,129),c.calculateMortarAim(500,-129)]))"
solutions = json.loads(subprocess.check_output(['node','-e',js],cwd=ROOT,text=True))
fig, axes = plt.subplots(2,1,figsize=(12,8.8),dpi=150,sharex=True,sharey=True,layout='constrained')
for ax, delta, solution, color in zip(axes,[129,-129],solutions,['#f3ac55','#64d5cf']):
    theta = solution['angle'] / 180 * 3.14
    vx = 151 * math.cos(theta)
    apex_height = 151**2 * math.sin(theta)**2 / (2*32.16) - 17.8
    apex_x = solution['aim']/2
    t, h, x = 0.0, apex_height - delta, apex_x
    xs, ys = [x], [h + delta]
    while h >= 0:
        vy=32.16*t; t+=.01; x+=vx*.01; h-=vy*.01
        xs.append(x); ys.append(h + delta)
    ascent_x=np.linspace(0,apex_x,100)
    u=ascent_x/apex_x
    ax.plot(ascent_x,apex_height*(2*u-u*u),color=color,alpha=.55,lw=2,ls=(0,(5,4)),label='Подъём — условная схема')
    ax.plot(xs,ys,color=color,lw=3,label='Расчётный участок падения')
    ax.axhline(0,color='#72818a',lw=1,alpha=.6)
    ax.axhline(delta,color='#f27568',lw=1,ls=':',alpha=.8)
    ax.scatter([0,500],[0,delta],c=['#62d4cf','#f27568'],s=85,edgecolors='white',zorder=5)
    ax.scatter([apex_x],[apex_height],s=28,c='white',zorder=6)
    ax.annotate('A', (0,0),xytext=(8,8),textcoords='offset points',weight='bold')
    ax.annotate('B', (500,delta),xytext=(8,8),textcoords='offset points',weight='bold')
    ax.annotate('Вершина модели', (apex_x,apex_height),xytext=(0,12),textcoords='offset points',ha='center',fontsize=10,color='#dbe7ea')
    ax.annotate('',xy=(535,delta),xytext=(535,0),arrowprops=dict(arrowstyle='<->',color='#fff',lw=1.4))
    ax.text(544,delta/2,f'{delta:+} м',va='center',fontsize=11,weight='bold')
    title = 'Цель выше на 129 м' if delta>0 else 'Цель ниже на 129 м'
    ax.set_title(f'{title}  ·  прицел ≈ {solution["aim"]} м',loc='left',fontsize=15,weight='bold',pad=10)
    ax.set_ylabel('Высота относительно A, м');ax.grid(color='#768c95',alpha=.17)
    ax.set_xlim(-40,610);ax.set_ylim(-180,380)
axes[0].legend(loc='upper right',frameon=True,facecolor='#19232d',edgecolor='#465763',labelcolor='#edf4f6',fontsize=9)
axes[-1].set_xlabel('Горизонтальное расстояние, м')
fig.suptitle('2. Вид сбоку: оценка траектории и настройка прицела',x=.02,ha='left',fontsize=18,weight='bold')
fig.savefig(OUT/'mortar-trajectories.png',bbox_inches='tight');plt.close(fig)
print('Saved diagrams; model results:',[(s['aim'],s['angle']) for s in solutions])
