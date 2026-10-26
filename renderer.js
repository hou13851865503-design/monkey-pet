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

  // 朝向帧映射：k∈[-2,2] => 帧序号（禁用 04/05/06 背面帧）
  const K2D = { '-2': 6, '-1': 7, '0': 0, '1': 1, '2': 2 };
  const POSITIVE = ['cheer', 'love', 'shy'];

  let state = 'idle';
  let focusing = false;
  let direction = 0;
  let blinkTimer = null, emotionTimer = null;

  function showDirection() {
    if (state === 'emotion' || state === 'drag' || state === 'focus' || state === 'sleepy') return;
    show('d' + direction);
  }
  function enter(s) {
    state = s;
    document.body.classList.toggle('dragging', s === 'drag');
    if (s === 'idle') showDirection();
    else if (s === 'sleepy') show('e_sleepy');
    else if (s === 'drag') show('e_surprised');
    else if (s === 'focus') show('e_thinking');
  }
  function triggerEmotion(name, holdMs = 1500) {
    if (state === 'drag') return;
    clearTimeout(emotionTimer);
    enter('emotion');
    show('e_' + name);
    emotionTimer = setTimeout(() => { enter(focusing ? 'focus' : 'idle'); }, holdMs);
  }
  function scheduleBlink() {
    const wait = 2200 + Math.random() * 4200;
    blinkTimer = setTimeout(() => {
      if (state === 'idle' && !focusing) {
        show('e_wink');
        setTimeout(() => { if (state === 'idle' && !focusing) showDirection(); }, 130);
      }
      scheduleBlink();
    }, wait);
  }

  // 平滑倾斜
  const tiltTarget = { rx: 0, ry: 0 };
  const tiltCur = { rx: 0, ry: 0 };

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
    tiltTarget.ry = clamp(dx * 0.09, -16, 16);
    tiltTarget.rx = clamp(dy * 0.06, -10, 10);
    if (!focusing) {
      const deg = Math.atan2(dx, 140) * 180 / Math.PI;
      const k = clamp(Math.round(deg / 45), -2, 2);
      const idx = K2D[k];
      if (idx !== direction) { direction = idx; showDirection(); }
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
    if (ipc.onEmotion) {
      ipc.onEmotion((n) => {
        if (n === 'idle') enter(focusing ? 'focus' : 'idle');
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
    tilt.style.transform = `perspective(700px) rotateY(${tiltCur.ry}deg) rotateX(${tiltCur.rx}deg)`;
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
    if (ipc && ipc.debug) ipc.debug('pointerdown');
    downX = e.screenX; downY = e.screenY;
    downCX = e.clientX; downCY = e.clientY;
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
      if (ipc && ipc.debug) ipc.debug('moved screen=' + dScreen + ' client=' + dClient);
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
})();
