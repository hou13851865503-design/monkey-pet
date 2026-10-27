// 渲染进程：2D 八面图 + 情绪图 桌宠
// - 17 张素材叠层，靠 opacity 交叉淡入 => 切帧连贯
// - 朝向映射禁用 04/05/06（带背面）=> 永不露背
// - #tilt 透视倾斜 => 伪 3D 跟随鼠标
// - 长按 + 滚轮 => 缩放
// - 系统闲置 => 睡觉；键鼠动 => 醒
// - 鼠标在身上快速来回 => 撸它（害羞/喜欢）
// - 双击 => 情绪菜单；单击 => 随机开心
// - 番茄钟专注态 => 思考脸
// 状态机：idle / emotion / drag / sleepy / focus
(function () {
  const stage = document.getElementById('stage');
  const tilt = document.getElementById('tilt');
  const breath = document.getElementById('breath');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // 眩晕 / 喝酒抽烟等"正在做动作"的状态，提前声明避免 enter() 里的 TDZ
  let dizzyUntil = 0, dizzyTimer = null;
  let actionUntil = 0, actionTimer = null;

  // ---- 素材：8 朝向(d0..d7) + 9 情绪(e_xxx) ----
  const imgs = {};
  function addFrame(key, src) {
    const im = document.createElement('img');
    im.className = 'f';
    im.src = src;
    im.draggable = false;
    breath.appendChild(im);
    imgs[key] = im;
  }
  for (let i = 0; i < 8; i++) addFrame('d' + i, `./assets/${String(i + 1).padStart(2, '0')}.png`);

  // ---- 眩晕眼：在两只眼睛的位置画旋转螺旋（盖住原瞳孔）----
  function spiralPath(cx, cy, r0, r1, turns, steps) {
    let d = '';
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const a = t * turns * Math.PI * 2;
      const r = r0 + (r1 - r0) * t;
      d += (i ? ' L' : 'M') + (cx + Math.cos(a) * r).toFixed(2) + ' ' + (cy + Math.sin(a) * r).toFixed(2);
    }
    return d;
  }
  (function buildDizzyEyes() {
    const els = document.querySelectorAll('.eye');
    if (!els.length) return;
    const d = spiralPath(12, 12, 1, 8.4, 2.6, 120);
    const svg = '<svg viewBox="0 0 24 24"><path d="' + d +
      '" fill="none" stroke="#2f2116" stroke-width="1.6" stroke-linecap="round"/></svg>';
    els.forEach((el) => { el.innerHTML = svg; });
  })();
  ['angry', 'cheer', 'love', 'sad', 'shy', 'sleepy', 'surprised', 'thinking', 'wink']
    .forEach((n) => addFrame('e_' + n, `./assets/emotion_${n}.png`));

  let current = null;
  function show(key) {
    if (key === current) return;
    if (current && imgs[current]) imgs[current].classList.remove('active');
    if (imgs[key]) imgs[key].classList.add('active');
    current = key;
    // 告诉主进程当前帧，主进程据此做"透明处穿透"的像素判定
    try { if (window.pet && window.pet.setFrame) window.pet.setFrame(key); } catch (_) {}
  }

  // 朝向：素材只有"正面/轻微右转/右侧面"，没有左向帧（04/05/06 是背面）。
  // 左向 = 把右向帧水平镜像，身体和眼神一起翻，效果自然。
  const POSITIVE = ['cheer', 'love', 'shy'];

  let state = 'idle';
  let focusing = false;
  let dirK = 0;          // -2..2，负数=看左（镜像）
  let direction = 0;
  let blinkTimer = null, emotionTimer = null;

  function showDirection() {
    if (state === 'emotion' || state === 'drag' || state === 'focus' || state === 'sleepy') return;
    const k = dirK;
    // 0 => 正面(01)；±1 => 轻微转向(02)；±2 => 侧面(03)
    const idx = k === 0 ? 0 : (Math.abs(k) >= 2 ? 2 : 1);
    document.body.classList.toggle('faceLeft', k < 0);
    show('d' + idx);
  }
  function enter(s) {
    if (Date.now() < actionUntil) return;   // 抽烟/喝酒期间不让其它状态抢画面
    state = s;
    document.body.classList.toggle('dragging', s === 'drag');
    if (s !== 'idle') document.body.classList.remove('faceLeft');  // 情绪/拖拽帧不镜像
    if (isDizzy() && s !== 'idle') return;   // 眩晕期间保持晕脸，不被切走
    if (s === 'idle') showDirection();
    else if (s === 'sleepy') show('e_sleepy');
    else if (s === 'drag') show('e_surprised');
    else if (s === 'focus') show('e_thinking');
  }
  function triggerEmotion(name, holdMs = 1500) {
    if (state === 'drag') return;
    if (isBusy()) return;                  // 眩晕 / 抽烟喝酒期间不被其它情绪打断
    clearTimeout(emotionTimer);
    enter('emotion');
    show('e_' + name);
    emotionTimer = setTimeout(() => { enter(focusing ? 'focus' : 'idle'); }, holdMs);
  }

  // ---- 眩晕：快速拖动触发，头顶转圈 + 身体摇晃 ----
  function isDizzy() { return Date.now() < dizzyUntil; }
  function setDizzy(ms = 2000) {
    if (Date.now() < actionUntil) return;   // 正在抽烟/喝酒时不打断
    dizzyUntil = Date.now() + ms;
    document.body.classList.add('dizzy');
    document.body.classList.remove('faceLeft');   // 眩晕用正面帧，别镜像
    clearTimeout(emotionTimer);
    show('d0');                    // 正面睁眼帧，和眼白/螺旋的位置对齐
    clearTimeout(dizzyTimer);
    dizzyTimer = setTimeout(() => {
      dizzyUntil = 0;
      document.body.classList.remove('dizzy');
      enter(focusing ? 'focus' : 'idle');
    }, ms);
  }

  // ---- 抽烟 / 喝酒：30 秒，随机两种结局 ----
  function isBusy() { return Date.now() < dizzyUntil || Date.now() < actionUntil; }

  function clearAction() {
    document.body.classList.remove('drunk', 'asleep', 'smoking', 'blue', 'revive', 'drinking');
    actionUntil = 0;
  }

  function setAction(classes, ms, frame) {
    clearTimeout(actionTimer);
    clearAction();
    document.body.classList.remove('faceLeft');
    classes.split(' ').forEach((c) => { if (c) document.body.classList.add(c); });
    state = 'action';
    show(frame);
    actionUntil = Date.now() + ms;
    actionTimer = setTimeout(() => {
      clearAction();
      enter(focusing ? 'focus' : 'idle');
    }, ms);
  }

  function startAction(type) {
    if (isBusy()) return;
    const parts = String(type).split(':');   // drink:drunk / smoke:revive 可强制结局（调试用）
    const kind = parts[0];
    const force = parts[1] || '';
    if (kind === 'drink') {
      if (force === 'drunk' || (!force && Math.random() < 0.55)) {
        setAction('drinking drunk', 30000, 'e_shy');        // 打醉拳：左右晃悠
      } else {
        setAction('drinking asleep', 30000, 'e_sleepy');    // 呼呼大睡
      }
    } else if (kind === 'smoke') {
      if (force === 'revive' || (!force && Math.random() < 0.5)) {
        setAction('smoking revive', 30000, 'e_cheer');   // 满血复活
        setTimeout(() => document.body.classList.remove('revive'), 1500);
      } else {
        setAction('smoking blue', 30000, 'e_sad');       // 忧郁
      }
    }
  }
  function scheduleBlink() {
    const wait = 2200 + Math.random() * 4200;
    blinkTimer = setTimeout(() => {
      if (isBusy()) { scheduleBlink(); return; }   // 晕着/抽烟喝酒的时候别眨眼
      if (state === 'idle' && !focusing) {
        show('e_wink');
        setTimeout(() => { if (state === 'idle' && !focusing) showDirection(); }, 130);
      }
      scheduleBlink();
    }, wait);
  }

  // ---- 空闲自主状态：每隔 9~21 秒自己搞点事（环顾 / 换表情 / 小跳）----
  let autoMood = true;
  let moodTimer = null;
  function pickMood() {
    const r = Math.random();
    if (ipc && ipc.debug) ipc.debug('mood r=' + r.toFixed(2));
    if (r < 0.5) {
      // 环顾：临时转向一侧，再回到原来的朝向
      const old = dirK;
      const side = Math.random() < 0.5 ? -1 : 1;
      dirK = side * (Math.random() < 0.45 ? 2 : 1);
      showDirection();
      setTimeout(() => {
        if (state === 'idle' && !isDizzy()) { dirK = old; showDirection(); }
      }, 1100 + Math.random() * 900);
    } else if (r < 0.88) {
      const list = ['cheer', 'love', 'thinking', 'shy', 'surprised'];
      triggerEmotion(list[Math.floor(Math.random() * list.length)], 1400 + Math.random() * 700);
    } else {
      document.body.classList.add('hop');
      setTimeout(() => document.body.classList.remove('hop'), 650);
    }
  }
  function scheduleMood() {
    clearTimeout(moodTimer);
    // 2~5 分钟才换一次状态，避免"一直在动"的烦躁感
    const wait = 120000 + Math.random() * 180000;
    moodTimer = setTimeout(() => {
      if (autoMood && state === 'idle' && !focusing && !isDizzy() && !document.hidden) pickMood();
      scheduleMood();
    }, wait);
  }

  // 平滑倾斜 + 上下位移（看向上方/下方时整体轻微上移/下沉）
  const tiltTarget = { rx: 0, ry: 0 };
  const tiltCur = { rx: 0, ry: 0 };
  const gaze = { y: 0 };

  // ---- 撸它：鼠标在身上快速左右来回 => 害羞/喜欢 ----
  let revs = [], lastSign = 0, lastRub = 0;
  function rubCheck(dx, dy) {
    const overPet = Math.abs(dx) < 100 && Math.abs(dy) < 120;
    if (!overPet) { lastSign = 0; revs = []; return; }
    const s = Math.sign(dx);
    const now = Date.now();
    if (s !== 0 && lastSign !== 0 && s !== lastSign) revs.push(now);
    if (s !== 0) lastSign = s;
    revs = revs.filter((t) => now - t < 800);
    if (revs.length >= 3 && now - lastRub > 2500) {
      lastRub = now; revs = [];
      triggerEmotion(Math.random() < 0.5 ? 'shy' : 'love', 1800);
    }
  }

  // 鼠标偏移 -> 朝向 + 倾斜 + 撸
  function handleCursor(dx, dy) {
    if (state === 'sleepy') enter('idle');
    // 归一化：以窗口宽/高的 4 倍为满量程，让"正脸"占主导（原来 1.4 倍太灵敏，一动就侧面）
    const nx = clamp(dx / (Math.max(60, window.innerWidth) * 4), -1, 1);
    const ny = clamp(dy / (Math.max(60, window.innerHeight) * 4), -1, 1);

    // 身体（朝向帧）+ 眼神（随头转动）+ 透视倾斜 一起动
    tiltTarget.ry = nx * 12;
    tiltTarget.rx = ny * 14;
    gaze.y = ny * 3;                       // 鼠标偏上 => 整体微升；偏下 => 微沉

    if (!focusing) {
      // 分段阈值：近距离保持正脸，远一点才轻微转，很远才侧面
      const a = Math.abs(nx);
      let k = 0;
      if (a >= 0.8) k = 2;
      else if (a >= 0.4) k = 1;
      if (nx < 0) k = -k;
      if (k !== dirK) { dirK = k; showDirection(); }
    }
    rubCheck(dx, dy);
  }

  // ---- 数据源：Electron 走 IPC；浏览器预览则监听鼠标 ----
  const ipc = window.pet || null;
  if (ipc) {
    ipc.onCursor(handleCursor);
    if (ipc.onIdle) {
      ipc.onIdle((asleep) => {
        if (focusing) return;
        if (asleep) { if (state !== 'drag') enter('sleepy'); }
        else if (state === 'sleepy') enter('idle');
      });
    }
    if (ipc.onAction) {
      ipc.onAction((type) => startAction(type));
    }
    if (ipc.onAutoMood) {
      ipc.onAutoMood((on) => { autoMood = !!on; });
    }
    if (ipc.onEmotion) {
      ipc.onEmotion((n) => {
        if (n === 'idle') enter(focusing ? 'focus' : 'idle');
        else if (n === 'dizzy') setDizzy(2000);
        else triggerEmotion(n);
      });
    }
    if (ipc.onFocus) {
      ipc.onFocus((on) => {
        focusing = !!on;
        enter(on ? 'focus' : 'idle');
      });
    }
    if (ipc.onClickThrough) {
      ipc.onClickThrough((on) => document.body.classList.toggle('clickthrough', !!on));
    }
    if (ipc.onSpeak) {
      ipc.onSpeak((text) => {
        try {
          if (!text || !window.speechSynthesis) return;
          window.speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(String(text));
          u.lang = 'zh-CN';
          u.rate = 1.05;
          u.pitch = 1.05;
          const voices = window.speechSynthesis.getVoices() || [];
          const zh = voices.find((v) => /zh|Chinese|Xiaoxiao|Huihui|Yaoyao/i.test(v.lang + ' ' + v.name));
          if (zh) u.voice = zh;
          window.speechSynthesis.speak(u);
        } catch (_) {}
      });
      try { window.speechSynthesis && window.speechSynthesis.getVoices(); } catch (_) {}
    }
  } else {
    document.addEventListener('mousemove', (e) => {
      const r = stage.getBoundingClientRect();
      handleCursor(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
    });
    window.Monkey2D = {
      setEmotion: (n) => { if (n === 'idle') { enter('idle'); } else triggerEmotion(n); },
    };
  }

  (function tiltLoop() {
    requestAnimationFrame(tiltLoop);
    tiltCur.rx += (tiltTarget.rx - tiltCur.rx) * 0.15;
    tiltCur.ry += (tiltTarget.ry - tiltCur.ry) * 0.15;
    tilt.style.transform = `perspective(700px) rotateY(${tiltCur.ry}deg) rotateX(${tiltCur.rx}deg) translateY(${gaze.y}px)`;
  })();

  // ---- 透明区域不挡鼠标 ----
  // 由主进程每 30ms 读取真实光标位置 + 当前帧 alpha 判断并切换，渲染端不参与，
  // 这样拖拽过程中不会被"忽略鼠标"打断。

  // ---- 拖拽 / 单击 / 双击 / 长按 ----
  let dragging = false, moved = false;
  let downX = 0, downY = 0, clickTimer = null;
  let downCX = 0, downCY = 0;
  let lpTimer = null, longPressed = false;

  function scheduleClick() {
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      if (state !== 'drag') triggerEmotion(POSITIVE[Math.floor(Math.random() * POSITIVE.length)]);
    }, 230);
  }
  function onWinUp() {
    window.removeEventListener('mouseup', onWinUp);
    window.removeEventListener('blur', onWinUp);
    clearTimeout(lpTimer);
    if (!dragging) return;
    dragging = false;
    if (longPressed) { longPressed = false; return; }   // 长按已触发专注，不再触发点击情绪
    if (moved) { if (ipc) ipc.dragEnd(); triggerEmotion('cheer', 1200); }
    else { scheduleClick(); }
  }

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true; moved = false; longPressed = false;
    downX = e.screenX; downY = e.screenY;
    downCX = e.clientX; downCY = e.clientY;
    scheduleMood();   // 每次互动后重新计时，安静 2~5 分钟
    window.addEventListener('mouseup', onWinUp);
    window.addEventListener('blur', onWinUp);
    // 长按 0.65s 且没拖动 => 开始 / 停止专注
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => {
      if (dragging && !moved) {
        longPressed = true;
        if (ipc && ipc.focusToggle) ipc.focusToggle();
      }
    }, 650);
    try { stage.setPointerCapture(e.pointerId); } catch (_) {}
  });
  stage.addEventListener('pointermove', (e) => {
    if (!dragging || moved) return;
    // screenX 在个别环境下不会随移动更新，用 clientX 兜底，两者取大
    const dScreen = Math.abs(e.screenX - downX) + Math.abs(e.screenY - downY);
    const dClient = Math.abs(e.clientX - downCX) + Math.abs(e.clientY - downCY);
    if (Math.max(dScreen, dClient) > 4) {
      moved = true;
      clearTimeout(lpTimer);
      enter('drag');
      if (ipc) ipc.dragStart();
    }
  });
  function endPointer(e) {
    try { stage.releasePointerCapture(e.pointerId); } catch (_) {}
    onWinUp();
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  stage.addEventListener('dblclick', (e) => {
    e.preventDefault();
    clearTimeout(clickTimer);          // 双击时取消"单击随机情绪"
    clearTimeout(lpTimer);
    if (ipc && ipc.showEmotionMenu) ipc.showEmotionMenu();
    else triggerEmotion('surprised');
  });

  // ---- 右键菜单 ----
  stage.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (ipc) ipc.showContextMenu();
  });

  // ---- 长按 + 滚轮缩放 ----
  let previewScale = 1;
  stage.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !(e.buttons & 1)) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    if (ipc) ipc.zoomBy(factor);
    else { previewScale = clamp(previewScale * factor, 0.5, 2.5); stage.style.transform = `scale(${previewScale})`; }
  }, { passive: false });

  // ---- 拖图片到小猴身上 -> 名片结构化抽取 ----
  const stopDrag = (e) => { e.preventDefault(); e.stopPropagation(); };
  window.addEventListener('dragover', stopDrag);
  window.addEventListener('drop', stopDrag);
  stage.addEventListener('dragover', (e) => { e.preventDefault(); try { e.dataTransfer.dropEffect = 'copy'; } catch (_) {} });
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    const p = f.path || '';
    if (ipc && ipc.extractCard) {
      if (!p) { triggerEmotion('sad'); return; }
      triggerEmotion('surprised');
      ipc.extractCard(p);
    }
  });

  enter('idle');
  scheduleBlink();
  scheduleMood();
})();
