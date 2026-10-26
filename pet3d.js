// pet3d.js — 3D 小猴引擎（Three.js r149 UMD，全局 THREE）
// 设计目标：
//  1) 头部/身体持续"看向"鼠标（gaze tracking），永远不会背对鼠标
//  2) 身体偏航(bodyYaw)有上限，头部额外补偿(headYaw)，形成"回头看"——解决"背对我"
//  3) 每帧对所有角度做 lerp 平滑，动作连贯不突变
//  API: Monkey3D.init({container}) / setTarget(dx,dy) / setEmotion(name) / setIdle()
(function () {
  const THREE = window.THREE;
  if (!THREE) { console.error('Three.js 未加载'); return; }

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---- 配置 ----
  const SENS_X = 2.2, SENS_Y = 1.4, FOCAL = 90;   // 鼠标偏移 -> 朝向灵敏度
  const LERP = 0.12;                              // 每帧平滑系数（越小越柔）

  // ---- 颜色（可被情绪染色）----
  const BASE = {
    fur:   new THREE.Color(0x8a5a2b),
    face:  new THREE.Color(0xe8c39e),
    belly: new THREE.Color(0xf0d3b0),
    ear:   new THREE.Color(0xd9a679),
  };

  // 情绪配置：tint 染色目标色 + 各姿态目标值
  const EMO = {
    idle:      { tint: null, arm: 0,   roll: 0,     eye: 1,    bounce: 0,   pitch: 0,    mouth: 0,  shake: false },
    cheer:     { tint: 0xff9ec7, tintS: 0.45, arm: 1,   roll: 0,     eye: 1.1,  bounce: 1,   pitch: 0,    mouth: 0.2, shake: false },
    love:      { tint: 0xff7eb6, tintS: 0.5,  arm: 0.35, roll: 0,    eye: 1.15, bounce: 0.5, pitch: 0,    mouth: 0.1, shake: false },
    shy:       { tint: 0xffb3c8, tintS: 0.5,  arm: 0.6,  roll: -0.18, eye: 1,    bounce: 0,   pitch: 0,    mouth: 0,   shake: false },
    angry:     { tint: 0xff5a4d, tintS: 0.6,  arm: -0.2, roll: 0.05, eye: 0.85, bounce: 0,   pitch: 0,    mouth: 0.15, shake: true },
    sad:       { tint: 0x6fa8ff, tintS: 0.5,  arm: 0,   roll: 0,     eye: 0.95, bounce: 0,   pitch: 0.25, mouth: 0,   shake: false },
    sleepy:    { tint: null, arm: 0,   roll: 0,     eye: 0.06, bounce: 0,   pitch: 0.30, mouth: 0,   shake: false },
    surprised: { tint: 0xfff0a0, tintS: 0.25, arm: 0.5, roll: 0,    eye: 1.5,  bounce: 0,   pitch: -0.12, mouth: 1, shake: false },
    thinking:  { tint: null, arm: 0.5,  roll: 0.22,  eye: 1,    bounce: 0,   pitch: 0,    mouth: 0,   shake: false },
    wink:      { tint: null, arm: 0,   roll: 0,     eye: 1,    bounce: 0,   pitch: 0,    mouth: 0,   shake: false },
  };

  // ---- 运行时状态 ----
  let renderer, scene, camera, container;
  let root, headPivot, leftArm, rightArm, tail;
  let leftEye, rightEye, mouth;
  let tintMats = [];   // {mat, base}
  let emoColor = new THREE.Color(0xffffff);
  let emoTintS = 0;

  const cur = { bodyYaw: 0, headYaw: 0, headPitch: 0, headRoll: 0, eye: 1, arm: 0, bounce: 0, pitch: 0, mouth: 0, tint: 0 };
  const tgt = { bodyYaw: 0, headYaw: 0, headPitch: 0, roll: 0, eye: 1, arm: 0, bounce: 0, pitch: 0, mouth: 0 };

  let nextBlink = performance.now() + 2000;
  let blinkStart = -1000;
  let winkUntil = 0;
  let curEmotion = 'idle';

  function buildMonkey() {
    root = new THREE.Group();
    root.scale.setScalar(0.82);
    root.position.y = -0.15;

    const furMat = new THREE.MeshStandardMaterial({ color: BASE.fur.clone(), roughness: 0.85 });
    const faceMat = new THREE.MeshStandardMaterial({ color: BASE.face.clone(), roughness: 0.8 });
    const bellyMat = new THREE.MeshStandardMaterial({ color: BASE.belly.clone(), roughness: 0.85 });
    const earMat = new THREE.MeshStandardMaterial({ color: BASE.ear.clone(), roughness: 0.85 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x2b1d12, roughness: 0.6 });
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
    const mouthMat = new THREE.MeshStandardMaterial({ color: 0x7a3b2a, roughness: 0.7 });
    tintMats = [
      { mat: furMat, base: BASE.fur },
      { mat: faceMat, base: BASE.face },
      { mat: bellyMat, base: BASE.belly },
      { mat: earMat, base: BASE.ear },
    ];

    // 躯干
    const torso = new THREE.Mesh(new THREE.SphereGeometry(0.9, 32, 32), furMat);
    torso.scale.set(1, 1.15, 0.9);
    root.add(torso);
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.55, 24, 24), bellyMat);
    belly.scale.set(0.9, 1.05, 0.45);
    belly.position.set(0, -0.1, 0.6);
    root.add(belly);

    // 腿
    const legGeo = new THREE.CylinderGeometry(0.22, 0.2, 0.5, 16);
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, furMat);
      leg.position.set(sx * 0.38, -1.0, 0.1);
      root.add(leg);
    }

    // 手臂（绕肩 pivot 摆动）
    function makeArm(side) {
      const piv = new THREE.Group();
      piv.position.set(side * 0.82, 0.5, 0.05);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.14, 0.9, 16), furMat);
      arm.position.set(0, -0.45, 0);
      piv.add(arm);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 16), furMat);
      hand.position.set(0, -0.92, 0);
      piv.add(hand);
      piv.userData.baseZ = side < 0 ? 0.15 : -0.15;
      piv.rotation.z = piv.userData.baseZ;
      root.add(piv);
      return piv;
    }
    leftArm = makeArm(-1);
    rightArm = makeArm(1);

    // 尾巴
    const tailCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.2, -0.7, -0.1),
      new THREE.Vector3(0.6, -0.95, -0.35),
      new THREE.Vector3(1.0, -0.7, -0.6),
      new THREE.Vector3(1.15, -0.2, -0.85),
      new THREE.Vector3(0.9, 0.15, -1.0),
    ]);
    tail = new THREE.Mesh(new THREE.TubeGeometry(tailCurve, 32, 0.12, 10, false), furMat);
    root.add(tail);

    // 头部 pivot（位于躯干上方）
    headPivot = new THREE.Group();
    headPivot.position.set(0, 1.25, 0);
    root.add(headPivot);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.75, 32, 32), furMat);
    head.scale.set(1, 0.95, 1);
    headPivot.add(head);

    const face = new THREE.Mesh(new THREE.SphereGeometry(0.52, 24, 24), faceMat);
    face.scale.set(1, 0.92, 0.62);
    face.position.set(0, -0.02, 0.42);
    headPivot.add(face);

    // 耳朵
    for (const sx of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.3, 20, 20), furMat);
      ear.position.set(sx * 0.72, 0.18, -0.05);
      headPivot.add(ear);
      const inner = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 16), earMat);
      inner.position.set(sx * 0.74, 0.18, 0.12);
      headPivot.add(inner);
    }

    // 口鼻
    const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.26, 20, 20), faceMat);
    muzzle.scale.set(1, 0.8, 0.7);
    muzzle.position.set(0, -0.22, 0.6);
    headPivot.add(muzzle);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 12), darkMat);
    nose.position.set(0, -0.12, 0.82);
    headPivot.add(nose);

    // 嘴（惊讶时张开）
    mouth = new THREE.Mesh(new THREE.SphereGeometry(0.1, 14, 14), mouthMat);
    mouth.scale.set(1.2, 0.4, 0.6);
    mouth.position.set(0, -0.34, 0.74);
    mouth.visible = false;
    headPivot.add(mouth);

    // 眼睛（白 + 瞳，整体可缩放做眨眼/眨眼）
    function makeEye(sx) {
      const g = new THREE.Group();
      const white = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 16), whiteMat);
      white.scale.set(1, 1.2, 0.7);
      g.add(white);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.08, 14, 14), darkMat);
      pupil.position.set(0, 0, 0.1);
      g.add(pupil);
      g.position.set(sx * 0.22, 0.08, 0.55);
      headPivot.add(g);
      return g;
    }
    leftEye = makeEye(-1);
    rightEye = makeEye(1);

    scene.add(root);
  }

  function setTarget(dx, dy) {
    const yaw = Math.atan2(dx * SENS_X, FOCAL);
    const pitch = Math.atan2(-dy * SENS_Y, FOCAL);
    const bodyYaw = clamp(yaw * 0.7, -1.4, 1.4);
    tgt.bodyYaw = bodyYaw;
    // 头部补偿：bodyYaw + headYaw ≈ 真实朝向，永远指向鼠标
    tgt.headYaw = clamp(yaw - bodyYaw, -0.95, 0.95);
    tgt.headPitch = pitch * 0.7;     // 叠加情绪俯仰
  }

  function applyEmotion(name) {
    curEmotion = name;
    const e = EMO[name] || EMO.idle;
    if (name === 'wink') { winkUntil = performance.now() + 160; return; } // 仅眨一眼，姿态保持 idle
    tgt.roll = e.roll || 0;
    tgt.eye = e.eye != null ? e.eye : 1;
    tgt.arm = e.arm || 0;
    tgt.bounce = e.bounce || 0;
    tgt.pitch = e.pitch || 0;
    tgt.mouth = e.mouth || 0;
    if (e.tint != null) { emoColor.set(e.tint); emoTintS = e.tintS || 0.5; }
    else { emoTintS = 0; }
  }

  function setIdle() { applyEmotion('idle'); }

  function loop() {
    requestAnimationFrame(loop);
    const t = performance.now();

    // 眨眼
    if (t > nextBlink) { blinkStart = t; nextBlink = t + 2000 + Math.random() * 4000; }
    const blinking = (t - blinkStart) < 120;
    const blinkMul = blinking ? 0.08 : 1;
    const winking = t < winkUntil;

    // 平滑插值
    cur.bodyYaw += (tgt.bodyYaw - cur.bodyYaw) * LERP;
    cur.headYaw += (tgt.headYaw - cur.headYaw) * LERP;
    cur.headPitch += ((tgt.headPitch + (EMO[curEmotion].pitch || 0)) - cur.headPitch) * LERP;
    cur.headRoll += (tgt.roll - cur.headRoll) * LERP;
    cur.eye += (tgt.eye - cur.eye) * LERP;
    cur.arm += (tgt.arm - cur.arm) * LERP;
    cur.bounce += (tgt.bounce - cur.bounce) * LERP;
    cur.mouth += (tgt.mouth - cur.mouth) * LERP;
    cur.tint += ((EMO[curEmotion].tint ? 1 : 0) * emoTintS - cur.tint) * LERP * 0.6;

    // 呼吸
    const breath = Math.sin(t * 0.0022) * 0.03;
    root.scale.set(0.82 * (1 + breath * 0.4), 0.82 * (1 + breath), 0.82 * (1 + breath * 0.4));
    root.position.y = -0.15 + cur.bounce * Math.abs(Math.sin(t * 0.012)) * 0.18;

    root.rotation.y = cur.bodyYaw;

    let shake = 0;
    if (EMO[curEmotion].shake) shake = Math.sin(t * 0.03) * 0.04;
    headPivot.rotation.y = cur.headYaw + shake;
    headPivot.rotation.x = -cur.headPitch;                       // -：正俯仰=抬头
    headPivot.rotation.z = cur.headRoll + Math.sin(t * 0.0015) * 0.025;  // 轻微 idle 摇摆

    const armBaseL = leftArm.userData.baseZ, armBaseR = rightArm.userData.baseZ;
    leftArm.rotation.z = armBaseL + cur.arm * 1.0;
    rightArm.rotation.z = armBaseR - cur.arm * 1.0;

    // 眼睛缩放（眨眼 / 眨眼）
    const esL = cur.eye * blinkMul * (winking ? 1 : 1);
    const esR = cur.eye * blinkMul * (winking ? 0.05 : 1);
    leftEye.scale.set(1, esL, 1);
    rightEye.scale.set(1, esR, 1);

    // 嘴
    mouth.visible = cur.mouth > 0.02;
    mouth.scale.set(1.2, 0.4 + cur.mouth * 1.6, 0.6);

    // 情绪染色
    for (const tm of tintMats) {
      tm.mat.color.copy(tm.base).lerp(emoColor, 0.55 * cur.tint);
    }

    renderer.render(scene, camera);
  }

  function onResize() {
    if (!renderer || !container) return;
    const w = container.clientWidth || window.innerWidth || 192;
    const h = container.clientHeight || window.innerHeight || 223;
    renderer.setSize(w, h);
    renderer.domElement.style.display = 'block';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function init(opts) {
    container = opts.container;
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setClearColor(0x000000, 0);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(38, 0.86, 0.1, 100);
    camera.position.set(0, 0.4, 5.4);
    camera.lookAt(0, 0.15, 0);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x554433, 0.95));
    const dir = new THREE.DirectionalLight(0xffffff, 0.75);
    dir.position.set(2, 4, 6);
    scene.add(dir);
    const fill = new THREE.DirectionalLight(0xffffff, 0.3);
    fill.position.set(-3, 1, 4);
    scene.add(fill);

    buildMonkey();
    onResize();
    window.addEventListener('resize', onResize);
    loop();
  }

  window.Monkey3D = { init, setTarget, setEmotion: applyEmotion, setIdle };
})();
