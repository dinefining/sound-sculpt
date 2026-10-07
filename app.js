(() => {
'use strict';
const TAU = Math.PI * 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const $ = id => document.getElementById(id);

/* ------------------------------------------------------------------ data */
const pct = v => Math.round(v*100)+'%';
const fTime = v => v < 1 ? Math.round(v*1000)+'MS' : v.toFixed(2)+'S';

// Every sound control owns one direction on the sphere. Pull the surface out along it and the
// control goes up, push it in and it goes down. Knobs do the same thing from the panel.
const CONTROLS = [
  {k:'amp',      label:'AMP',     min:0,    max:2,     def:1,     fmt:v=>v.toFixed(2)},
  {k:'pitch',    label:'PITCH',   min:-24,  max:24,    def:0,     fmt:v=>(v<-0.05?'-':'+')+Math.abs(v).toFixed(1)},
  {k:'dist',     label:'DRIVE',   min:0,    max:1,     def:0,     fmt:pct},
  {k:'comp',     label:'COMP',    min:1,    max:20,    def:1,     fmt:v=>v.toFixed(1)+':1'},
  {k:'chorus',   label:'CHORUS',  min:0,    max:1,     def:0,     fmt:pct},
  {k:'reverb',   label:'REVERB',  min:0,    max:1,     def:0,     fmt:pct},
  {k:'filter',   label:'CUTOFF',  min:30,   max:20000, def:20000, log:true, fmt:v=>v>=1000?(v/1000).toFixed(1)+'K':Math.round(v)+''},
  {k:'legato',   label:'LEGATO',  min:0.05, max:1,     def:1,     fmt:v=>v>=0.999?'FULL':pct(v)},
  {k:'step',     label:'STEP',    min:0.5,  max:16,    def:4,     log:true, fmt:v=>(v<10?v.toFixed(1):Math.round(v))+'/S'},
  {k:'reso',     label:'RESO',    min:0,    max:1,     def:0,     fmt:pct},
  {k:'attack',   label:'ATTACK',  min:0.002,max:2,     def:0.005, log:true, fmt:fTime},
  {k:'release',  label:'RELEASE', min:0.01, max:4,     def:0.08,  log:true, fmt:fTime},
  {k:'lfoDepth', label:'LFO',     min:0,    max:1,     def:0,     fmt:pct},
  {k:'lfoRate',  label:'RATE',    min:0.05, max:12,    def:1,     log:true, fmt:v=>(v<1?v.toFixed(2):v.toFixed(1))+'HZ'},
  {k:'echo',     label:'ECHO',    min:0,    max:1,     def:0,     fmt:pct},
  {k:'echoTime', label:'TIME',    min:0.04, max:1.2,   def:0.375, log:true, fmt:fTime},
  {k:'pan',      label:'PAN',     min:-1,   max:1,     def:0,     fmt:v=>Math.abs(v)<0.02?'C':(v<0?'L':'R')+Math.round(Math.abs(v)*100)},
];
const BRUSH = {k:'brush', label:'BRUSH', min:0.08, max:1.4, def:0.35, log:true, fmt:v=>v.toFixed(2)};
const SHAPE_KEYS = ['amp','pitch','dist','comp','chorus','reverb','filter'];

const posToVal = (pr, t) => pr.log ? pr.min*Math.pow(pr.max/pr.min, t) : pr.min + (pr.max - pr.min)*t;
const valToPos = (pr, v) => clamp(pr.log ? Math.log(v/pr.min)/Math.log(pr.max/pr.min) : (v - pr.min)/(pr.max - pr.min), 0, 1);
for (const c of CONTROLS) c.t0 = valToPos(c, c.def);

const V = Object.fromEntries(CONTROLS.map(c => [c.k, c.def]));          // live control values
const T = {legato:1, step:4, reso:0, attack:0.005, release:0.08, lfoRate:1, lfoDepth:0, echo:0, echoTime:0.375, pan:0};
const voices = new Set();
const S = {axes:false, pmode:'loop', sample:'sine', fileName:null, brush:BRUSH.def, playing:false, rec:false};
let params = {amp:1,pitch:0,dist:0,comp:1,chorus:0,reverb:0,filter:20000};

function weld(g){
  const p = g.attributes.position, ix = g.index ? g.index.array : null, n = ix ? ix.length : p.count;
  const map = new Map(), pos = [], tris = [], tmp = new Array(n);
  for (let i = 0; i < n; i++){
    const v = ix ? ix[i] : i, x = p.getX(v), y = p.getY(v), z = p.getZ(v);
    const key = Math.round(x*1e4)+','+Math.round(y*1e4)+','+Math.round(z*1e4);
    let id = map.get(key);
    if (id === undefined){ id = pos.length/3; pos.push(x,y,z); map.set(key,id); }
    tmp[i] = id;
  }
  for (let i = 0; i < n; i += 3){
    const a = tmp[i], b = tmp[i+1], c = tmp[i+2];
    if (a!==b && b!==c && a!==c) tris.push(a,b,c);
  }
  return {pos:new Float32Array(pos), tris};
}

function buildTopo(n, tris){
  const seen = new Set(), edges = [], nb = Array.from({length:n}, () => []);
  const add = (a,b) => {
    const lo = Math.min(a,b), hi = Math.max(a,b), k = lo*n+hi;
    if (!seen.has(k)){ seen.add(k); edges.push(lo,hi); nb[lo].push(hi); nb[hi].push(lo); }
  };
  for (let t = 0; t < tris.length; t += 3){ add(tris[t],tris[t+1]); add(tris[t+1],tris[t+2]); add(tris[t+2],tris[t]); }
  const off = new Int32Array(n+1); let c = 0;
  for (let i = 0; i < n; i++){ off[i] = c; c += nb[i].length; }
  off[n] = c;
  const adj = new Int32Array(c);
  for (let i = 0; i < n; i++) adj.set(nb[i], off[i]);
  return {edges, off, adj};
}

/* ---------------------------------------------------------------- three */
const stage = $('stage');
const renderer = new THREE.WebGLRenderer({antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setClearColor(0xefefec, 1);
const canvas = renderer.domElement;
stage.prepend(canvas);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
const cam = {zoom:1};
scene.add(new THREE.AmbientLight(0xffffff, 0.78));
const sun = new THREE.DirectionalLight(0xffffff, 0.3); sun.position.set(-1, 1.4, 2.2);
camera.add(sun); scene.add(camera);

const group = new THREE.Group(); scene.add(group);
const meshMat = new THREE.ShaderMaterial({
  uniforms:{uColor:{value:new THREE.Color(0x2ae22a)}},
  vertexShader:`varying vec3 vN; varying vec3 vV;
    void main(){ vN = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
  fragmentShader:`uniform vec3 uColor; varying vec3 vN; varying vec3 vV;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
    void main(){
      vec3 n = normalize(vN);
      float diff = max(dot(n, normalize(vec3(-0.45,0.6,0.85))), 0.0);
      float shade = 0.66 + 0.38*diff;                       // soft key light
      float grad = mix(0.9, 1.05, n.y*0.5 + 0.5);            // lighter on top, a touch darker underneath
      float rim = pow(1.0 - max(dot(n, normalize(vV)), 0.0), 3.0);
      vec3 c = uColor*shade*grad + rim*0.06;
      c += (hash(gl_FragCoord.xy) - 0.5)*0.045;              // fine grain
      gl_FragColor = vec4(c, 1.0);
    }`
});

const ringPts = []; for (let i = 0; i < 72; i++) ringPts.push(new THREE.Vector3(Math.cos(i/72*TAU), Math.sin(i/72*TAU), 0));
const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ringPts),
  new THREE.LineBasicMaterial({color:0x000000, transparent:true, opacity:0.35, depthTest:false}));
ring.visible = false; ring.renderOrder = 3; group.add(ring);

// marker for the axis of the knob under the pointer
const markTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  g.strokeStyle = '#1b1b1b'; g.lineWidth = 3; g.beginPath(); g.arc(32,32,26,0,TAU); g.stroke();
  g.fillStyle = '#1b1b1b'; g.beginPath(); g.arc(32,32,6,0,TAU); g.fill(); return new THREE.CanvasTexture(c); })();
const marker = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0,0,0],3)),
  new THREE.PointsMaterial({size:13, sizeAttenuation:false, map:markTex, transparent:true, depthTest:false}));
marker.visible = false; marker.renderOrder = 4; marker.frustumCulled = false; group.add(marker);
const spokes = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(17*6), 3)),
  new THREE.LineBasicMaterial({color:0x8c8c86, transparent:true, opacity:0.6}));
spokes.visible = false; spokes.frustumCulled = false; group.add(spokes);

/* ------------------------------------------------------- the sphere: radius only */
// The surface only ever moves straight in or out from the centre, so it can't fold over itself.
const RMIN = 0.25, RMAX = 2.3, D = 0.25, SENS = 0.3;   // SENS: a stroke over ~30% of a spot's region can sweep its whole range            // D: how far out (or in) a control's full travel is
const KAPPA = 14;                                   // how sharply neighbouring spots hand over to each other

const W = (() => { const w = weld(new THREE.IcosahedronGeometry(1, 31)); return w; })();
const N = W.pos.length/3;
const UD = new Float32Array(W.pos);                 // unit direction of every vertex
for (let i = 0; i < N; i++){ const j = 3*i, l = Math.hypot(UD[j],UD[j+1],UD[j+2]); UD[j]/=l; UD[j+1]/=l; UD[j+2]/=l; }
const TOPO = buildTopo(N, W.tris);
const R = new Float32Array(N).fill(1);
const P = new Float32Array(N*3);
function syncAll(){ for (let i = 0; i < N; i++){ const j = 3*i, r = R[i]; P[j] = UD[j]*r; P[j+1] = UD[j+1]*r; P[j+2] = UD[j+2]*r; } }
function syncList(L){ for (const i of L){ const j = 3*i, r = R[i]; P[j] = UD[j]*r; P[j+1] = UD[j+1]*r; P[j+2] = UD[j+2]*r; } }
syncAll();
const posAttr = new THREE.BufferAttribute(P, 3); posAttr.setUsage(THREE.DynamicDrawUsage);
const mg = new THREE.BufferGeometry(); mg.setAttribute('position', posAttr); mg.setIndex(W.tris);
const mesh = new THREE.Mesh(mg, meshMat); mesh.frustumCulled = false; group.add(mesh);
let dirty = true;
function markDirty(){ posAttr.needsUpdate = true; mg.boundingSphere = null; mg.boundingBox = null; dirty = true; }

// one axis per control, spread evenly (golden-angle spiral), first one facing the viewer
const AX = CONTROLS.map((c, k) => {
  const n = CONTROLS.length, y = 1 - (k + 0.5)/n*2, rr = Math.sqrt(1 - y*y), a = k*Math.PI*(3 - Math.sqrt(5));
  const v = new THREE.Vector3(Math.cos(a)*rr, y, Math.sin(a)*rr);
  return v;
});
{ // rotate the set so AMP sits front and centre
  const q = new THREE.Quaternion().setFromUnitVectors(AX[0].clone(), new THREE.Vector3(0.35, 0.25, 1).normalize());
  AX.forEach(v => v.applyQuaternion(q));
}
const NA = AX.length;
const AXW = (() => {
  const lists = AX.map(() => ({read:[], rw:[], center:0, best:-2}));
  const c = new Float32Array(NA), e = new Float32Array(NA);
  for (let i = 0; i < N; i++){
    let mx = -2;
    for (let k = 0; k < NA; k++){
      const a = AX[k]; c[k] = UD[3*i]*a.x + UD[3*i+1]*a.y + UD[3*i+2]*a.z;
      if (c[k] > mx) mx = c[k];
      if (c[k] > lists[k].best){ lists[k].best = c[k]; lists[k].center = i; }
    }
    let se = 0; for (let k = 0; k < NA; k++){ e[k] = Math.exp(KAPPA*(c[k] - mx)); se += e[k]; }
    for (let k = 0; k < NA; k++){ const w = e[k]/se; if (w > 0.005){ lists[k].read.push(i); lists[k].rw.push(w); } }
  }
  return lists.map(l => {
    const rw = Float32Array.from(l.rw); let sw = 0, s2 = 0;
    for (const w of rw){ sw += w; s2 += w*w; }
    // the knob bump for an axis is its own weight map, so raising one spot lifts its whole region smoothly
    return {read:l.read, rw, sw:sw*SENS, m:s2/(sw*SENS), center:l.center};
  });
})();
const AXD = new Float32Array(CONTROLS.length);   // current average push/pull per axis

function readAxes(){
  for (let k = 0; k < NA; k++){
    const a = AXW[k]; let s = 0;
    for (let n = 0; n < a.read.length; n++) s += a.rw[n]*(R[a.read[n]] - 1);
    AXD[k] = s/a.sw;
  }
}
// Controls that rest in the middle (AMP, PITCH, PAN…) go up when pulled and down when pushed.
// Controls that rest at an end (DRIVE at 0, CUTOFF wide open…) move away from rest either way,
// so no push or pull is ever dead.
const dToT = (c, d) => c.t0 <= 0.001 ? Math.min(Math.abs(d)/D, 1) : c.t0 >= 0.999 ? 1 - Math.min(Math.abs(d)/D, 1)
  : d >= 0 ? c.t0 + (1 - c.t0)*Math.min(d/D, 1) : c.t0 - c.t0*Math.min(-d/D, 1);
const tToD = (c, t) => c.t0 <= 0.001 ? t*D : c.t0 >= 0.999 ? -(1 - t)*D : t >= c.t0 ? (t - c.t0)/(1 - c.t0)*D : -(c.t0 - t)/c.t0*D;
function setAxis(k, t){
  // a knob turn: move axis k to t while holding every other axis where it is
  const tgt = new Float32Array(NA);
  readAxes(); tgt.set(AXD); tgt[k] = tToD(CONTROLS[k], t);
  const corr = new Float32Array(NA);
  for (let it = 0; it < 8; it++){
    let worst = 0;
    for (let j = 0; j < NA; j++){ corr[j] = (tgt[j] - AXD[j])/AXW[j].m; worst = Math.max(worst, Math.abs(tgt[j] - AXD[j])); }
    if (worst < 2e-5) break;
    for (let j = 0; j < NA; j++){
      if (Math.abs(corr[j]) < 1e-7) continue;
      const a = AXW[j], d = corr[j];
      for (let n = 0; n < a.read.length; n++){ const i = a.read[n]; R[i] = clamp(R[i] + d*a.rw[n], RMIN, RMAX); }
    }
    readAxes();
  }
  syncAll(); markDirty();
}

function updateFromShape(){
  readAxes();
  CONTROLS.forEach((c, k) => { V[c.k] = posToVal(c, dToT(c, AXD[k])); });
  for (const k of SHAPE_KEYS) params[k] = V[k];
  for (const k in T) T[k] = V[k];
  applyAudio(params); applyTone();
  if (S.playing && (T.legato < 0.999) !== gated) play();
}

/* ------------------------------------------------------------------ audio */
let ctx = null, A = {}, src = null, srcGain = null, curveAmt = -1, levelBuf = null, fileBuf = null, level = 0;
const bufCache = {};

function makeIR(c, sec){
  const sr = c.sampleRate, N = Math.floor(sr*sec), b = c.createBuffer(2, N, sr);
  for (let ch = 0; ch < 2; ch++){
    const d = b.getChannelData(ch);
    for (let i = 0; i < N; i++){ const t = i/N; d[i] = (Math.random()*2-1)*Math.pow(1-t, 3.2)*Math.min(1, i/(sr*0.008)); }
  }
  return b;
}

function buildGraph(c){
  const A = {};
  A.input = c.createGain();
  A.shaper = c.createWaveShaper();
  A.filter = c.createBiquadFilter(); A.filter.type = 'lowpass'; A.filter.frequency.value = 20000; A.filter.Q.value = 0.7;
  A.filter2 = c.createBiquadFilter(); A.filter2.type = 'lowpass'; A.filter2.frequency.value = 20000; A.filter2.Q.value = 0.7;
  A.comp = c.createDynamicsCompressor(); A.comp.threshold.value = 0; A.comp.ratio.value = 1; A.comp.knee.value = 6; A.comp.attack.value = 0.004; A.comp.release.value = 0.18;
  A.makeup = c.createGain();
  A.busA = c.createGain(); A.busB = c.createGain();
  A.chDelay = c.createDelay(0.05); A.chDelay.delayTime.value = 0.007;
  A.chFb = c.createGain(); A.chFb.gain.value = 0;
  A.chWet = c.createGain(); A.chWet.gain.value = 0;
  A.lfo = c.createOscillator(); A.lfo.frequency.value = 0.7;
  A.lfoAmt = c.createGain(); A.lfoAmt.gain.value = 0;
  A.lfo.connect(A.lfoAmt); A.lfoAmt.connect(A.chDelay.delayTime); A.lfo.start();
  A.conv = c.createConvolver(); A.conv.buffer = IR || (IR = makeIR(c, 2.8));
  A.revWet = c.createGain(); A.revWet.gain.value = 0;
  A.dryB = c.createGain();
  A.master = c.createGain();
  A.limit = c.createDynamicsCompressor(); A.limit.threshold.value = -3; A.limit.knee.value = 0; A.limit.ratio.value = 20; A.limit.attack.value = 0.002; A.limit.release.value = 0.1;
  A.input.connect(A.shaper); A.shaper.connect(A.filter); A.filter.connect(A.filter2); A.filter2.connect(A.comp); A.comp.connect(A.makeup); A.makeup.connect(A.busA);
  A.busA.connect(A.busB); A.busA.connect(A.chDelay); A.chDelay.connect(A.chFb); A.chFb.connect(A.chDelay); A.chDelay.connect(A.chWet); A.chWet.connect(A.busB);
  A.busB.connect(A.dryB); A.dryB.connect(A.master); A.busB.connect(A.conv); A.conv.connect(A.revWet); A.revWet.connect(A.master);
  A.echo = c.createDelay(2); A.echo.delayTime.value = 0.375;
  A.echoTone = c.createBiquadFilter(); A.echoTone.type = 'lowpass'; A.echoTone.frequency.value = 4500;
  A.echoFb = c.createGain(); A.echoFb.gain.value = 0;
  A.echoWet = c.createGain(); A.echoWet.gain.value = 0;
  A.busB.connect(A.echo); A.echo.connect(A.echoTone); A.echoTone.connect(A.echoFb); A.echoFb.connect(A.echo);
  A.echoTone.connect(A.echoWet); A.echoWet.connect(A.master); A.echoWet.connect(A.conv);
  A.lfo2 = c.createOscillator(); A.lfo2.frequency.value = 1;
  A.lfo2Amt = c.createGain(); A.lfo2Amt.gain.value = 0;
  A.lfo2.connect(A.lfo2Amt); A.lfo2Amt.connect(A.filter.detune); A.lfo2Amt.connect(A.filter2.detune); A.lfo2.start();
  A.pan = c.createStereoPanner ? c.createStereoPanner() : null;
  if (A.pan){ A.master.connect(A.pan); A.pan.connect(A.limit); } else A.master.connect(A.limit);
  return A;
}
let IR = null;
function initAudio(){
  if (ctx){ if (ctx.state !== 'running') ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC();
  A = buildGraph(ctx);
  A.an = ctx.createAnalyser(); A.an.fftSize = 512;
  A.limit.connect(A.an); A.an.connect(ctx.destination);
  levelBuf = new Float32Array(A.an.fftSize);
  setCurve(0);
  applyAudio(params, true);
  applyTone(true);
}

function makeCurve(a){
  const N = 2048, cv = new Float32Array(N), k = a*30;
  const steps = a > 0.25 ? Math.round(Math.pow(2, 8 - (a-0.25)/0.75*5)) : 0;
  const norm = k > 0.001 ? Math.tanh(k) : 1;
  for (let i = 0; i < N; i++){
    const x = i/(N-1)*2 - 1;
    let y = k > 0.001 ? Math.tanh(k*x)/norm : x;
    if (steps) y = Math.round(y*steps)/steps;
    cv[i] = y*(1 - 0.35*a);
  }
  return cv;
}
function setCurve(a, G){
  G = G || A; if (G === A) curveAmt = a;
  G.shaper.curve = makeCurve(a);
  G.shaper.oversample = a > 0 ? '4x' : 'none';
}

function applyAudio(p, now, G, C){
  G = G || A; C = C || ctx; if (!C) return;
  const live = G === A, t = C.currentTime, tc = now ? 0.001 : 0.03;
  const set = (prm, v) => now && !live ? prm.setValueAtTime(v, 0) : prm.setTargetAtTime(v, t, tc);
  set(G.master.gain, p.amp);
  if (live){
    const rate = Math.pow(2, p.pitch/12);
    if (src) set(src.playbackRate, rate);
    for (const v of voices) set(v.s.playbackRate, rate);
    if (Math.abs(p.dist - curveAmt) > 0.006 || (p.dist === 0 && curveAmt !== 0)) setCurve(p.dist);
  } else setCurve(p.dist, G);
  set(G.filter.frequency, p.filter); set(G.filter2.frequency, p.filter);
  set(G.comp.ratio, p.comp);
  set(G.comp.threshold, p.comp <= 1.001 ? 0 : Math.max(-42, -8 - (p.comp-1)*1.8));
  set(G.makeup.gain, 1 + Math.min(0.8, (p.comp-1)*0.05));
  const c = p.chorus;
  set(G.chWet.gain, c*0.75); set(G.lfoAmt.gain, c*0.0045); set(G.chDelay.delayTime, 0.007 + c*0.006); set(G.chFb.gain, c*0.6);
  set(G.revWet.gain, p.reverb*1.3); set(G.dryB.gain, 1 - p.reverb*0.45);
}

/* procedural sound library — every built-in sound is synthesised here, no files */
const SOUND_GROUPS = [
  ['DRUMS',    [['kick','Kick'],['k808','808 Kick'],['snare','Snare'],['clap','Clap'],['rim','Rimshot'],['hat','Closed Hat'],['ohat','Open Hat'],
                ['tomL','Low Tom'],['tomM','Mid Tom'],['tomH','High Tom'],['crash','Crash'],['ride','Ride'],['cowbell','Cowbell'],['shaker','Shaker']]],
  ['WAVES',    [['sine','Sine Tone'],['tri','Triangle'],['square','Square'],['saw','Sawtooth'],['pulse','Pulse 25%'],['supersaw','Supersaw']]],
  ['BASS',     [['bass','Bass Stab'],['sub','Sub Bass'],['acid','Acid'],['reese','Reese']]],
  ['KEYS',     [['pluck','Pluck'],['epiano','E-Piano'],['organ','Organ'],['bell','FM Bell'],['marimba','Marimba'],['chip','Chip Arp']]],
  ['TEXTURES', [['pad','Pad'],['choir','Choir'],['vocal','Vocal Chop'],['drone','Drone'],['wind','Wind'],['noise','White Noise'],['pink','Pink Noise'],['vinyl','Vinyl Crackle']]],
];
const SAMPLES = SOUND_GROUPS.flatMap(g => g[1]);
const ONE_SHOTS = new Set(['kick','k808','snare','clap','rim','hat','ohat','tomL','tomM','tomH','crash','ride','cowbell','shaker',
  'bass','sub','acid','pluck','epiano','bell','marimba','chip','vocal']);

function synth(name, sr){
  const rnd = () => Math.random()*2 - 1;
  const lp1 = fc => { let y = 0; const a = 1 - Math.exp(-TAU*fc/sr); return x => (y += a*(x - y)); };
  const bq = (type, f, Q) => {                       // RBJ biquad
    const w = TAU*f/sr, cs = Math.cos(w), al = Math.sin(w)/(2*Q);
    let b0, b1, b2, a0 = 1 + al, a1 = -2*cs, a2 = 1 - al;
    if (type === 'lp'){ b0 = (1 - cs)/2; b1 = 1 - cs; b2 = b0; }
    else if (type === 'hp'){ b0 = (1 + cs)/2; b1 = -(1 + cs); b2 = b0; }
    else { b0 = al; b1 = 0; b2 = -al; }
    b0/=a0; b1/=a0; b2/=a0; a1/=a0; a2/=a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return x => { const y = b0*x + b1*x1 + b2*x2 - a1*y1 - a2*y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
  };
  const additive = (N, f, amp, maxH) => {            // band-limited periodic wave from harmonic amplitudes
    const d = new Float32Array(N), H = Math.min(maxH || 80, Math.floor(sr*0.45/f));
    for (let h = 1; h <= H; h++){ const a = amp(h); if (!a) continue; const w = TAU*f*h/sr; for (let i = 0; i < N; i++) d[i] += a*Math.sin(w*i); }
    return d;
  };
  const sq = (ph) => (ph % 1) < 0.5 ? 1 : -1;
  const loopXF = (gen, sec, xf) => {                  // render a little extra and crossfade it in so the loop is seamless
    const N = Math.round(sec*sr), XF = Math.round(xf*sr), tmp = gen(N + XF), d = new Float32Array(N);
    for (let i = 0; i < N; i++){ if (i < XF){ const x = i/XF; d[i] = tmp[i]*Math.sqrt(x) + tmp[N + i]*Math.sqrt(1 - x); } else d[i] = tmp[i]; }
    return d;
  };
  const metal = (N, freqs, decay, bpF, hpF) => {     // 808-style cymbal: six square oscillators through filters
    const d = new Float32Array(N), bp = bq('bp', bpF, 1.2), hp = bq('hp', hpF, 0.7), ph = freqs.map(() => Math.random());
    for (let i = 0; i < N; i++){
      let s = 0; for (let k = 0; k < freqs.length; k++){ ph[k] += freqs[k]/sr; s += sq(ph[k]); }
      d[i] = hp(bp(s*0.3 + rnd()*0.25))*Math.exp(-i/sr/decay);
    }
    return d;
  };
  const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];
  const tom = (f0, len) => {
    const N = Math.round(len*sr), d = new Float32Array(N); let ph = 0;
    for (let i = 0; i < N; i++){ const t = i/sr, f = f0*(1 + 0.6*Math.exp(-t*25)); ph += TAU*f/sr;
      d[i] = Math.sin(ph)*Math.exp(-t*7)*Math.min(1, t*1500) + rnd()*0.15*Math.exp(-t*60); }
    return d;
  };
  let d;
  switch (name){
    /* ---------- drums */
    case 'kick': { const N = Math.round(0.5*sr); d = new Float32Array(N); let ph = 0;
      for (let i = 0; i < N; i++){ const t = i/sr, f = 46 + 120*Math.exp(-t*30); ph += TAU*f/sr;
        d[i] = Math.sin(ph)*Math.exp(-t*6.5)*Math.min(1, t*2000) + rnd()*Math.exp(-t*300)*0.25; } break; }
    case 'k808': { const N = Math.round(1.4*sr); d = new Float32Array(N); let ph = 0;
      for (let i = 0; i < N; i++){ const t = i/sr, f = 44 + 70*Math.exp(-t*22); ph += TAU*f/sr;
        d[i] = Math.tanh(1.6*Math.sin(ph))*Math.exp(-t*2.6)*Math.min(1, t*1500); } break; }
    case 'snare': { const N = Math.round(0.5*sr); d = new Float32Array(N); const hp = bq('hp', 1500, 0.7);
      for (let i = 0; i < N; i++){ const t = i/sr;
        d[i] = hp(rnd())*0.6*Math.exp(-t*15) + Math.sin(TAU*185*t)*Math.exp(-t*24)*0.7 + Math.sin(TAU*330*t)*Math.exp(-t*35)*0.3; } break; }
    case 'clap': { const N = Math.round(0.45*sr); d = new Float32Array(N); const bp = bq('bp', 1100, 1.1);
      for (let i = 0; i < N; i++){ const t = i/sr;
        let e = 0; for (const o of [0, 0.011, 0.022]) if (t >= o) e = Math.max(e, Math.exp(-(t - o)*180));
        e = Math.max(e, t > 0.03 ? 0.55*Math.exp(-(t - 0.03)*14) : 0);
        d[i] = bp(rnd())*e; } break; }
    case 'rim': { const N = Math.round(0.15*sr); d = new Float32Array(N); const bp = bq('bp', 3000, 2);
      for (let i = 0; i < N; i++){ const t = i/sr;
        d[i] = (Math.sin(TAU*1700*t)*0.6 + Math.sin(TAU*480*t)*0.5)*Math.exp(-t*90) + bp(rnd())*Math.exp(-t*250); } break; }
    case 'hat':   d = metal(Math.round(0.18*sr), METAL.map(f => f*1.9), 0.035, 10000, 7000); break;
    case 'ohat':  d = metal(Math.round(0.7*sr),  METAL.map(f => f*1.9), 0.22,  10000, 7000); break;
    case 'crash': d = metal(Math.round(2.2*sr),  METAL.map(f => f*1.6), 0.7,   7000,  4500); break;
    case 'ride': { const N = Math.round(1.8*sr); d = metal(N, METAL.map(f => f*2.4), 0.6, 9000, 6000);
      for (let i = 0; i < N; i++){ const t = i/sr; d[i] = d[i]*0.7 + Math.sin(TAU*3150*t)*0.25*Math.exp(-t*2.5); } break; }
    case 'tomL': d = tom(85, 0.7); break;
    case 'tomM': d = tom(125, 0.6); break;
    case 'tomH': d = tom(180, 0.5); break;
    case 'cowbell': { const N = Math.round(0.5*sr); d = new Float32Array(N); const bp = bq('bp', 2000, 1.4); let p1 = 0, p2 = 0;
      for (let i = 0; i < N; i++){ const t = i/sr; p1 += 540/sr; p2 += 800/sr;
        d[i] = bp(sq(p1) + sq(p2))*(0.7*Math.exp(-t*30) + 0.3*Math.exp(-t*6)); } break; }
    case 'shaker': { const N = Math.round(0.25*sr); d = new Float32Array(N); const hp = bq('hp', 5000, 0.8);
      for (let i = 0; i < N; i++){ const t = i/sr; d[i] = hp(rnd())*Math.min(1, t/0.03)*Math.exp(-Math.max(0, t - 0.03)*28); } break; }

    /* ---------- waves (2 s, whole cycles so they loop cleanly) */
    case 'sine':   d = additive(2*sr, 220, h => h === 1 ? 1 : 0); break;
    case 'tri':    d = additive(2*sr, 220, h => h % 2 ? ((h - 1)/2 % 2 ? -1 : 1)/(h*h) : 0); break;
    case 'square': d = additive(2*sr, 110, h => h % 2 ? 1/h : 0); break;
    case 'saw':    d = additive(2*sr, 110, h => 1/h, 60); break;
    case 'pulse':  d = additive(2*sr, 110, h => Math.sin(Math.PI*h*0.25)/h, 60); break;
    case 'supersaw': d = loopXF(N => { const out = new Float32Array(N);
        for (const det of [-0.11, -0.06, -0.025, 0, 0.025, 0.06, 0.11]){ const f = 110*Math.pow(2, det/12*2.2), w = additive(N, f, h => 1/h, 40);
          for (let i = 0; i < N; i++) out[i] += w[i]; } return out; }, 2, 0.3); break;

    /* ---------- bass */
    case 'bass': { const N = Math.round(0.5*sr); d = new Float32Array(N); let ph = 0, l1 = 0, l2 = 0;
      for (let i = 0; i < N; i++){ const t = i/sr; ph += 55/sr; ph -= Math.floor(ph);
        const x = (2*ph - 1)*0.7 + (ph < 0.5 ? 1 : -1)*0.3, fc = 140 + 2600*Math.exp(-t*14), a = 1 - Math.exp(-TAU*fc/sr);
        l1 += a*(x - l1); l2 += a*(l1 - l2); d[i] = l2*Math.exp(-t*4)*Math.min(1, t*800); } break; }
    case 'sub': { const N = Math.round(1.2*sr); d = new Float32Array(N);
      for (let i = 0; i < N; i++){ const t = i/sr; d[i] = (Math.sin(TAU*55*t) + 0.18*Math.sin(TAU*110*t))*Math.min(1, t*200)*Math.exp(-t*1.2); } break; }
    case 'acid': { const N = Math.round(0.6*sr); d = new Float32Array(N); let ph = 0;
      const st = {x1:0,x2:0,y1:0,y2:0};
      for (let i = 0; i < N; i++){ const t = i/sr; ph += 55/sr; ph -= Math.floor(ph);
        const fc = 180 + 2800*Math.exp(-t*9), w = TAU*fc/sr, cs = Math.cos(w), al = Math.sin(w)/(2*9);
        const a0 = 1 + al, b0 = (1 - cs)/2/a0, b1 = (1 - cs)/a0, a1 = -2*cs/a0, a2 = (1 - al)/a0;
        const x = 2*ph - 1, y = b0*x + b1*st.x1 + b0*st.x2 - a1*st.y1 - a2*st.y2;
        st.x2 = st.x1; st.x1 = x; st.y2 = st.y1; st.y1 = y;
        d[i] = Math.tanh(1.5*y)*Math.exp(-t*3)*Math.min(1, t*600); } break; }
    case 'reese': d = loopXF(N => { const out = new Float32Array(N), a = additive(N, 55, h => 1/h, 40), b = additive(N, 55.45, h => 1/h, 40), lp = bq('lp', 900, 0.8);
        for (let i = 0; i < N; i++) out[i] = lp(a[i] + b[i] + 0.8*Math.sin(TAU*55*i/sr)); return out; }, 2, 0.3); break;

    /* ---------- keys */
    case 'pluck': { const N = Math.round(1.6*sr), P = Math.round(sr/220), buf = new Float32Array(P).map(() => rnd()); d = new Float32Array(N);
      for (let i = 0; i < N; i++){ const j = i % P, nx = (j + 1) % P; const y = buf[j]; buf[j] = 0.996*0.5*(buf[j] + buf[nx]); d[i] = y; } break; }
    case 'epiano': { const N = Math.round(2*sr); d = new Float32Array(N);
      for (let i = 0; i < N; i++){ const t = i/sr, idx = 1.8*Math.exp(-t*3) + 0.15;
        d[i] = (Math.sin(TAU*220*t + idx*Math.sin(TAU*220*t)) + 0.15*Math.sin(TAU*220*14*t)*Math.exp(-t*18))*Math.exp(-t*1.6)*Math.min(1, t*400); } break; }
    case 'organ': d = additive(2*sr, 110, h => ({1:1, 2:0.8, 3:0.6, 4:0.5, 6:0.35, 8:0.3})[h] || 0); break;
    case 'bell': { const N = Math.round(3*sr); d = new Float32Array(N);
      for (let i = 0; i < N; i++){ const t = i/sr, idx = 4*Math.exp(-t*2);
        d[i] = Math.sin(TAU*440*t + idx*Math.sin(TAU*440*3.5*t))*Math.exp(-t*1.4)*Math.min(1, t*800); } break; }
    case 'marimba': { const N = Math.round(1*sr); d = new Float32Array(N);
      for (let i = 0; i < N; i++){ const t = i/sr;
        d[i] = (Math.sin(TAU*220*t)*Math.exp(-t*5) + 0.35*Math.sin(TAU*880*t)*Math.exp(-t*14) + 0.12*Math.sin(TAU*2200*t)*Math.exp(-t*40))*Math.min(1, t*1500); } break; }
    case 'chip': { const notes = [261.6, 329.6, 392, 523.3], step = 0.125, N = Math.round(8*step*sr); d = new Float32Array(N); let ph = 0;
      for (let i = 0; i < N; i++){ const t = i/sr, k = Math.floor(t/step), lt = t - k*step; ph += notes[k % 4]/sr;
        d[i] = sq(ph)*0.5*Math.exp(-lt*6)*Math.min(1, lt*2000)*Math.min(1, (step - lt)*400); } break; }

    /* ---------- textures */
    case 'pad': d = loopXF(N => { const out = new Float32Array(N), notes = [130.81, 164.81, 196.0, 246.94, 293.66], det = [-0.0045, 0, 0.0052];
        const ph = notes.map(() => [0,0,0]);
        for (let i = 0; i < N; i++){ const t = i/sr; let s = 0;
          for (let n = 0; n < notes.length; n++) for (let k = 0; k < 3; k++){
            ph[n][k] += TAU*notes[n]*(1 + det[k])*(1 + 0.0015*Math.sin(TAU*0.3*t + n))/sr;
            const p = ph[n][k]; s += Math.sin(p) + Math.sin(2*p)*0.35 + Math.sin(3*p)*0.18 + Math.sin(4*p)*0.08; }
          out[i] = s*(0.8 + 0.2*Math.sin(TAU*0.25*t)); }
        return out; }, 4, 0.4); break;
    case 'choir': d = loopXF(N => { const out = new Float32Array(N), F = [[700,1], [1220,0.5], [2600,0.25]];
        const fl = F.map(([f]) => bq('bp', f, 6)), ph = [0, 0, 0], det = [0.996, 1, 1.005];
        for (let i = 0; i < N; i++){ const t = i/sr; let x = 0;
          for (let v = 0; v < 3; v++){ ph[v] += 130.8*det[v]*(1 + 0.006*Math.sin(TAU*5.2*t + v*2))/sr; x += 2*(ph[v] % 1) - 1; }
          let y = 0; for (let k = 0; k < 3; k++) y += fl[k](x)*F[k][1];
          out[i] = y; }
        return out; }, 3, 0.4); break;
    case 'vocal': { const syl = [[730,1090,2440,165],[270,2290,3010,196],[570,840,2410,147]], N = Math.round(1.2*sr);
      const seg = 0.32, step = 0.4, bw = [80,100,140], gn = [1,0.55,0.3], y1 = [0,0,0], y2 = [0,0,0]; let ph = 0; d = new Float32Array(N);
      for (let i = 0; i < N; i++){
        const t = i/sr, si = Math.min(2, Math.floor(t/step)), lt = t - si*step, Fm = syl[si]; let s = 0;
        if (lt < seg){ const env = Math.min(1, lt/0.015)*Math.min(1, (seg - lt)/0.05), f0 = Fm[3]*(1 + 0.012*Math.sin(TAU*5.5*t))*(1 - 0.04*lt/seg);
          ph += f0/sr; ph -= Math.floor(ph); s = (2*ph - 1)*env + rnd()*0.04*env; }
        let out = 0;
        for (let k = 0; k < 3; k++){ const r = Math.exp(-Math.PI*bw[k]/sr), a1 = 2*r*Math.cos(TAU*Fm[k]/sr), a2 = -r*r;
          const yv = (1 - r)*s + a1*y1[k] + a2*y2[k]; y2[k] = y1[k]; y1[k] = yv; out += yv*gn[k]; }
        d[i] = out; } break; }
    case 'drone': d = loopXF(N => { const out = new Float32Array(N), a = additive(N, 55, h => 1/h, 30), b = additive(N, 55.3, h => 1/h, 30), c = additive(N, 82.6, h => 1/h, 20);
        let y = 0;
        for (let i = 0; i < N; i++){ const t = i/sr, fc = 300 + 250*Math.sin(TAU*0.125*t), al = 1 - Math.exp(-TAU*fc/sr);
          y += al*((a[i] + b[i] + 0.6*c[i]) - y); out[i] = y; }
        return out; }, 4, 0.5); break;
    case 'wind': d = loopXF(N => { const out = new Float32Array(N); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
        for (let i = 0; i < N; i++){ const t = i/sr, f = 700 + 450*Math.sin(TAU*0.17*t) + 200*Math.sin(TAU*0.41*t);
          const w = TAU*f/sr, cs = Math.cos(w), al = Math.sin(w)/(2*3), a0 = 1 + al;
          const x = rnd(), y = (al*x - al*x2 - (-2*cs)*y1 - (1 - al)*y2)/a0;
          x2 = x1; x1 = x; y2 = y1; y1 = y; out[i] = y*(0.6 + 0.4*Math.sin(TAU*0.23*t)); }
        return out; }, 4, 0.5); break;
    case 'noise': { const N = 2*sr; d = new Float32Array(N); for (let i = 0; i < N; i++) d[i] = rnd(); break; }
    case 'pink': { const N = 2*sr; d = new Float32Array(N); let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < N; i++){ const w = rnd();
        b0 = 0.99886*b0 + w*0.0555179; b1 = 0.99332*b1 + w*0.0750759; b2 = 0.969*b2 + w*0.153852; b3 = 0.8665*b3 + w*0.3104856;
        b4 = 0.55*b4 + w*0.5329522; b5 = -0.7616*b5 - w*0.016898; d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w*0.5362; b6 = w*0.115926; } break; }
    case 'vinyl': { const N = 3*sr; d = new Float32Array(N); const lp = lp1(3000), hp = bq('hp', 300, 0.7);
      for (let i = 0; i < N; i++){ let x = lp(rnd())*0.05;
        if (Math.random() < 18/sr) x += rnd()*0.9; if (Math.random() < 120/sr) x += rnd()*0.15;
        d[i] = hp(x); } break; }
    default: d = additive(2*sr, 220, h => h === 1 ? 1 : 0);
  }
  if (ONE_SHOTS.has(name)){ const F = Math.round(0.012*sr); for (let i = 0; i < F && i < d.length; i++) d[d.length - 1 - i] *= i/F; }
  let pk = 0; for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
  if (pk > 0) for (let i = 0; i < d.length; i++) d[i] *= 0.85/pk;
  return d;
}

function getBuffer(){
  if (S.sample === 'file') return fileBuf;
  if (!bufCache[S.sample]){
    const data = synth(S.sample, ctx.sampleRate), b = ctx.createBuffer(1, data.length, ctx.sampleRate);
    b.getChannelData(0).set(data); bufCache[S.sample] = b;
  }
  return bufCache[S.sample];
}

function applyTone(now, G, C){
  G = G || A; C = C || ctx; if (!C) return;
  const live = G === A, t = C.currentTime, tc = now ? 0.001 : 0.03;
  const set = (prm, v) => now && !live ? prm.setValueAtTime(v, 0) : prm.setTargetAtTime(v, t, tc);
  set(G.filter.Q, 0.7 + 16*Math.pow(T.reso, 1.5));
  set(G.lfo2.frequency, T.lfoRate);
  set(G.lfo2Amt.gain, T.lfoDepth*2400);
  set(G.echo.delayTime, T.echoTime);
  set(G.echoWet.gain, T.echo*0.7);
  set(G.echoFb.gain, T.echo*0.62);
  if (G.pan) set(G.pan.pan, T.pan);
}

/* ---------------------------------------------------------------- transport */
let playPos = 0, startOff = 0, recDest = null, recorder = null, recChunks = [];
let gated = false, seqTimer = null, nextNoteT = 0;
function curBuf(){ return ctx ? (S.sample === 'file' ? fileBuf : bufCache[S.sample]) : null; }

// LEGATO at FULL: one continuous loop. Below FULL: the sound retriggers STEP times a second,
// and each note lasts LEGATO × the step — t t t t.
function play(){
  initAudio();
  const buf = getBuffer(); if (!buf) return;
  stopAll(0.02);
  S.playing = true;
  gated = T.legato < 0.999;
  if (gated){
    nextNoteT = ctx.currentTime + 0.03;
    schedule(); seqTimer = setInterval(schedule, 25);
  } else {
    if (playPos >= buf.duration) playPos = 0;
    const t = ctx.currentTime, s = ctx.createBufferSource(), g = ctx.createGain();
    s.buffer = buf; s.loop = true; s.playbackRate.value = Math.pow(2, params.pitch/12);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + T.attack);
    s.connect(g); g.connect(A.input); s.start(t, playPos);
    s.onended = () => g.disconnect();
    src = s; srcGain = g;
  }
  renderUI();
}
function schedule(){
  const buf = getBuffer(); if (!buf || !S.playing || !gated) return;
  while (nextNoteT < ctx.currentTime + 0.12){
    const step = 1/T.step, len = Math.max(0.015, step*T.legato), t = nextNoteT;
    const atk = Math.max(0.002, Math.min(T.attack, len*0.5));
    const rel = Math.max(0.003, Math.min(T.release, len - atk));
    const s = ctx.createBufferSource(), g = ctx.createGain();
    s.buffer = buf; s.loop = true; s.playbackRate.value = Math.pow(2, params.pitch/12);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + atk);
    g.gain.setValueAtTime(1, Math.max(t + atk, t + len - rel)); g.gain.linearRampToValueAtTime(0, t + len);
    s.connect(g); g.connect(A.input);
    s.start(t, Math.min(startOff, buf.duration - 0.001)); s.stop(t + len + 0.02);
    const v = {s, g, t}; voices.add(v);
    s.onended = () => { g.disconnect(); voices.delete(v); };
    nextNoteT += step;
  }
}
function stopSource(fade){
  if (!src) return;
  const s = src, g = srcGain, t = ctx.currentTime;
  src = null; srcGain = null;
  g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + fade);
  try { s.stop(t + fade + 0.01); } catch (_) {}
}
function stopAll(fade){
  if (seqTimer){ clearInterval(seqTimer); seqTimer = null; }
  if (ctx){
    stopSource(fade);
    const t = ctx.currentTime;
    for (const v of voices){
      if (v.t > t){ try { v.s.stop(); } catch (_) {} continue; }
      v.g.gain.cancelScheduledValues(t); v.g.gain.setValueAtTime(v.g.gain.value, t); v.g.gain.linearRampToValueAtTime(0, t + fade);
      try { v.s.stop(t + fade + 0.01); } catch (_) {}
    }
  }
  S.playing = false;
}
function togglePlay(){ if (S.playing){ stopAll(T.release); renderUI(); } else play(); }
function seek(frac){
  initAudio(); const b = getBuffer(); if (!b) return;
  playPos = clamp(frac, 0, 0.999)*b.duration;
  startOff = playPos;                     // in step mode the strip sets where each note starts
  if (S.playing && !gated) play();
}
function loadFile(f){
  initAudio();
  const fr = new FileReader();
  fr.onload = () => {
    ctx.decodeAudioData(fr.result, buf => {
      fileBuf = buf; S.fileName = f.name.replace(/\.[^.]+$/, ''); S.sample = 'file'; playPos = 0;
      if (S.playing) play(); else renderUI();
    }, () => { $('smp').textContent = "COULDN'T READ FILE"; });
  };
  fr.readAsArrayBuffer(f);
}
function encodeWav(buf){
  const ch = buf.numberOfChannels, sr = buf.sampleRate, n = buf.length, bytes = 44 + n*ch*2;
  const dv = new DataView(new ArrayBuffer(bytes)), str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0,'RIFF'); dv.setUint32(4, bytes - 8, true); str(8,'WAVE'); str(12,'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, ch, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr*ch*2, true); dv.setUint16(32, ch*2, true); dv.setUint16(34, 16, true);
  str(36,'data'); dv.setUint32(40, n*ch*2, true);
  const data = []; for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  let o = 44; for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++){ const v = clamp(data[c][i], -1, 1); dv.setInt16(o, v < 0 ? v*0x8000 : v*0x7fff, true); o += 2; }
  return new Blob([dv], {type:'audio/wav'});
}
let exporting = false;
const LOOPS = 4;
function exportPlan(){
  const buf = curBuf() || (initAudio(), getBuffer());
  const rate = Math.pow(2, params.pitch/12), gatedNow = T.legato < 0.999;
  if (gatedNow){ const step = 1/T.step; return {gatedNow, one:Math.max(0.015, step*T.legato), loop:4*LOOPS*step, loopN:4*LOOPS, step}; }
  const one = buf.duration/rate; return {gatedNow, one, loop:one*LOOPS, loopN:LOOPS};
}
// mode 'one': a single pass (or a single note) with its natural tail.
// mode 'loop': LOOPS passes (or 16 steps); the reverb/echo tail is wrapped back onto the start so it loops seamlessly.
async function exportWav(mode){
  if (exporting) return;
  initAudio(); const buf = getBuffer(); if (!buf) return;
  exporting = true; renderUI();
  try {
    const sr = 44100, rate = Math.pow(2, params.pitch/12), plan = exportPlan(), loop = mode === 'loop';
    const dur = Math.min(60, loop ? plan.loop : plan.one);
    const tail = (T.echo > 0.02 || params.reverb > 0.02) ? 3 : 0.05;
    const oc = new OfflineAudioContext(2, Math.ceil((dur + tail)*sr), sr);
    const G = buildGraph(oc); G.limit.connect(oc.destination);
    applyAudio(params, true, G, oc); applyTone(true, G, oc);
    const note = (t, len, off, shaped) => {
      const s = oc.createBufferSource(), g = oc.createGain();
      s.buffer = buf; s.loop = true; s.playbackRate.value = rate;
      if (shaped){
        const atk = Math.max(0.002, Math.min(T.attack, len*0.5)), rel = Math.max(0.003, Math.min(T.release, len - atk));
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + atk);
        g.gain.setValueAtTime(1, Math.max(t + atk, t + len - rel)); g.gain.linearRampToValueAtTime(0, t + len);
      }
      s.connect(g); g.connect(G.input); s.start(t, off); s.stop(t + len + (shaped ? 0.02 : 0));
    };
    const off = Math.min(startOff, buf.duration - 0.001);
    if (plan.gatedNow){ const n = loop ? plan.loopN : 1; for (let k = 0; k < n; k++) note(k*plan.step, plan.one, off, true); }
    else note(0, dur, 0, !loop);                // a loop must not fade in/out at its seam
    let out = await oc.startRendering();
    if (loop){                                   // fold the tail onto the head, trim to exactly the loop length
      const N = Math.round(dur*sr), folded = new AudioBuffer({numberOfChannels:2, length:N, sampleRate:sr});
      for (let c = 0; c < 2; c++){
        const src = out.getChannelData(c), dst = folded.getChannelData(c);
        dst.set(src.subarray(0, N));
        for (let i = N; i < src.length; i++) dst[(i - N) % N] += src[i];
      }
      out = folded;
    }
    const name = (S.sample === 'file' ? S.fileName : SAMPLES.find(x => x[0] === S.sample)[1]).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const url = URL.createObjectURL(encodeWav(out));
    const a = document.createElement('a'); a.href = url;
    a.download = `sound-sculpt-${name}-${loop ? LOOPS + 'x-loop' : '1x'}.wav`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } finally { exporting = false; renderUI(); }
}

/* ------------------------------------------------------------ interaction */
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), tmpV = new THREE.Vector3();
const ptrs = new Map();
let gesture = null, hover = null, pendingKnob = null, knobDrag = null, knobHover = null, pendingCommit = false;
let hist = [], hpos = -1;
function commit(){
  hist = hist.slice(0, hpos + 1);
  hist.push({R:new Float32Array(R), brush:S.brush});
  if (hist.length > 80) hist.shift();
  hpos = hist.length - 1; renderUI();
}
function restore(st){
  if (gesture) cancelGesture();
  R.set(st.R); syncAll(); markDirty(); S.brush = st.brush; renderUI();
}
function undo(){ if (hpos > 0){ hpos--; restore(hist[hpos]); } }
function redo(){ if (hpos < hist.length - 1){ hpos++; restore(hist[hpos]); } }
function resetShape(){ if (gesture) cancelGesture(); R.fill(1); syncAll(); markDirty(); pendingCommit = true; }

function setRay(cx, cy){
  const r = canvas.getBoundingClientRect();
  ndc.set((cx - r.left)/r.width*2 - 1, -(cy - r.top)/r.height*2 + 1);
  ray.setFromCamera(ndc, camera);
}
function pick(cx, cy){
  setRay(cx, cy); const h = ray.intersectObject(mesh, false)[0];
  if (h) group.worldToLocal(h.point);
  return h || null;
}
function brushSet(c, radius){
  const list = [], w = [], r2 = radius*radius;
  for (let i = 0; i < N; i++){
    const dx = P[3*i]-c.x, dy = P[3*i+1]-c.y, dz = P[3*i+2]-c.z, d2 = dx*dx+dy*dy+dz*dz;
    if (d2 < r2){ const t = 1 - Math.sqrt(d2/r2); list.push(i); w.push(t*t*(3 - 2*t)); }
  }
  return {list, w:Float32Array.from(w)};
}
function startPush(e){
  const h = pick(e.clientX, e.clientY); if (!h) return false;
  const b = brushSet(h.point, S.brush);
  gesture = {type:'push', y0:e.clientY, r:S.brush, last:0, list:b.list, w:b.w, R0:new Float32Array(R), tmp:new Float32Array(b.list.length), hit:h.point.clone(), n:h.face.normal.clone()};
  return true;
}
function doPush(e){
  // drag up pulls out, down pushes in. Broad brush = more axes, harder = further along them.
  // Each move is relaxed a little so the surface stays soft.
  const g = gesture, lim = 1.1*g.r;
  const amt = clamp((g.y0 - e.clientY)*0.0032*(baseDist/cam.zoom/4.4)*(g.r/0.35), -lim, lim);
  const delta = amt - g.last; if (Math.abs(delta) < 1e-6) return;
  g.last = amt;
  const L = g.list, Wt = g.w, tmp = g.tmp, off = TOPO.off, adj = TOPO.adj;
  for (let k = 0; k < L.length; k++){ const i = L[k]; R[i] = clamp(R[i] + Wt[k]*delta, RMIN, RMAX); }
  for (let k = 0; k < L.length; k++){
    const i = L[k], o0 = off[i], o1 = off[i+1];
    let s = 0; for (let q = o0; q < o1; q++) s += R[adj[q]];
    tmp[k] = R[i] + (s/(o1 - o0) - R[i])*0.35*Wt[k];
  }
  for (let k = 0; k < L.length; k++) R[L[k]] = tmp[k];
  syncList(L); markDirty();
}
function cancelGesture(){
  if (gesture && gesture.R0){ R.set(gesture.R0); syncAll(); markDirty(); }
  gesture = null;
}
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _ux = new THREE.Vector3(1,0,0), _uy = new THREE.Vector3(0,1,0);
function orbit(dx, dy){
  _qa.setFromAxisAngle(_uy, dx*0.007); _qb.setFromAxisAngle(_ux, dy*0.007);
  group.quaternion.premultiply(_qa).premultiply(_qb).normalize();
}
function zoom(f){ cam.zoom = clamp(cam.zoom*f, 0.45, 2.6); }

canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, {x:e.clientX, y:e.clientY});
  if (ptrs.size === 2){
    if (gesture && gesture.type === 'push') cancelGesture();
    const [a, b] = [...ptrs.values()];
    gesture = {type:'pinch', mx:(a.x+b.x)/2, my:(a.y+b.y)/2, d:Math.hypot(a.x-b.x, a.y-b.y)};
    return;
  }
  if (ptrs.size > 2) return;
  const orbitBtn = e.pointerType === 'mouse' && e.button !== 0;
  if (!orbitBtn && startPush(e)) return;
  gesture = {type:'orbit', x:e.clientX, y:e.clientY};
});
canvas.addEventListener('pointermove', e => {
  if (e.pointerType === 'mouse') hover = {x:e.clientX, y:e.clientY};
  const p = ptrs.get(e.pointerId);
  if (!p || !gesture) return;
  p.x = e.clientX; p.y = e.clientY;
  if (gesture.type === 'orbit'){ orbit(e.clientX - gesture.x, e.clientY - gesture.y); gesture.x = e.clientX; gesture.y = e.clientY; }
  else if (gesture.type === 'pinch'){
    const [a, b] = [...ptrs.values()];
    const mx = (a.x+b.x)/2, my = (a.y+b.y)/2, d = Math.hypot(a.x-b.x, a.y-b.y);
    orbit(mx - gesture.mx, my - gesture.my);
    if (gesture.d > 0 && d > 0) zoom(gesture.d/d);
    gesture.mx = mx; gesture.my = my; gesture.d = d;
  }
  else if (gesture.type === 'push') doPush(e);
});
function endPtr(e){
  if (gesture && gesture.type === 'push' && gesture.last !== 0) pendingCommit = true;
  ptrs.delete(e.pointerId);
  if (!gesture) return;
  if (gesture.type === 'pinch' && ptrs.size === 1){ const [a] = [...ptrs.values()]; gesture = {type:'orbit', x:a.x, y:a.y}; }
  else if (ptrs.size === 0) gesture = null;
}
canvas.addEventListener('pointerup', endPtr);
canvas.addEventListener('pointercancel', endPtr);
canvas.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hover = null; });
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  let dy = e.deltaY || e.deltaX; if (e.deltaMode === 1) dy *= 16;
  if (e.shiftKey || e.ctrlKey) zoom(Math.exp(-dy*0.0015));
  else S.brush = clamp(S.brush*Math.exp(-dy*0.0015), BRUSH.min, BRUSH.max);
}, {passive:false});

stage.addEventListener('dragover', e => { e.preventDefault(); stage.classList.add('over'); });
stage.addEventListener('dragleave', () => stage.classList.remove('over'));
stage.addEventListener('drop', e => { e.preventDefault(); stage.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) loadFile(f); });

function showRing(p, n){
  ring.position.copy(p).addScaledVector(n, 0.006);
  ring.lookAt(tmpV.copy(p).add(n).applyMatrix4(group.matrixWorld));
  ring.scale.setScalar(S.brush); ring.visible = true;
}
function updateHover(){
  ring.visible = false;
  if (gesture && gesture.type === 'push'){ showRing(gesture.hit, gesture.n); }
  else if (hover && !gesture){ const h = pick(hover.x, hover.y); if (h) showRing(h.point, h.face.normal); }
  if (knobDrag && knobDrag.kn.pr === BRUSH && !ring.visible){
    const n = tmpV.set(0, 0, 1).applyQuaternion(group.quaternion.clone().invert()).clone();
    showRing(n.clone(), n);
  }
  // show where the hovered / turned knob lives on the sphere
  const kk = knobDrag ? knobDrag.kn.idx : knobHover;
  if (kk != null && kk >= 0){
    const i = AXW[kk].center, a = marker.geometry.attributes.position;
    a.setXYZ(0, P[3*i]*1.01, P[3*i+1]*1.01, P[3*i+2]*1.01); a.needsUpdate = true; marker.visible = true;
  } else marker.visible = false;
  if (S.axes) drawAxes();
}
function drawAxes(){
  const pa = spokes.geometry.attributes.position, r = canvas.getBoundingClientRect();
  const view = tmpV.copy(camera.position).normalize().applyQuaternion(group.quaternion.clone().invert());
  AX.forEach((a, k) => {
    const i = AXW[k].center, rc = R[i], r1 = rc*1.004, r2 = rc + 0.16, rl = rc + 0.27;
    const el = axLabels[k], facing = a.x*view.x + a.y*view.y + a.z*view.z;
    if (facing < -0.15){ pa.setXYZ(2*k, 0, 0, 0); pa.setXYZ(2*k+1, 0, 0, 0); el.style.display = 'none'; return; }
    pa.setXYZ(2*k, a.x*r1, a.y*r1, a.z*r1); pa.setXYZ(2*k+1, a.x*r2, a.y*r2, a.z*r2);
    const tip = new THREE.Vector3(a.x*rl, a.y*rl, a.z*rl).applyMatrix4(group.matrixWorld).project(camera);
    if (tip.z > 1){ el.style.display = 'none'; return; }
    el.style.display = '';
    el.style.opacity = facing < 0.1 ? 0.45 : 1;
    el.style.transform = `translate(${(tip.x + 1)/2*r.width}px,${(1 - tip.y)/2*r.height}px) translate(-50%,-50%)`;
  });
  pa.needsUpdate = true;
}

/* --------------------------------------------------------------------- knobs */
const KN = [];
function buildKnobs(el, list, idx0){
  list.forEach((pr, n) => {
    const idx = CONTROLS.indexOf(pr);
    const k = document.createElement('div'); k.className = 'knob' + (pr === BRUSH ? ' tool' : '');
    const cap = idx < 0 ? 'ct' : 'c' + ((idx % 4) + 1);
    k.innerHTML = `<span class="lb"><span class="n">${pr.label}<sup class="ov">OVER</sup></span><span class="v"></span></span><div class="cell"><div class="dial ${cap}"><div class="ptr"></div></div></div>`;
    const kn = {pr, idx, el:k, ptr:k.querySelector('.ptr'), v:k.querySelector('.v'), txt:'', ang:null};
    KN.push(kn);
    const getT = () => pr === BRUSH ? valToPos(pr, S.brush) : valToPos(pr, V[pr.k]);
    const setT = t => { if (pr === BRUSH) S.brush = posToVal(pr, t); else pendingKnob = {k:idx, t}; };
    k.addEventListener('pointerenter', () => { knobHover = idx; });
    k.addEventListener('pointerleave', () => { if (knobHover === idx) knobHover = null; });
    k.addEventListener('pointerdown', e => { k.setPointerCapture(e.pointerId); k.classList.add('drag'); knobDrag = {kn, y:e.clientY, t:getT()}; });
    k.addEventListener('pointermove', e => {
      if (!knobDrag || knobDrag.kn !== kn) return;
      knobDrag.t = clamp(knobDrag.t + (knobDrag.y - e.clientY)/(e.shiftKey ? 600 : 160), 0, 1);
      knobDrag.y = e.clientY; knobDrag.moved = true;
      setT(knobDrag.t);
    });
    const end = () => { k.classList.remove('drag'); if (knobDrag && knobDrag.kn === kn){ if (knobDrag.moved) pendingCommit = true; knobDrag = null; } };
    k.addEventListener('pointerup', end); k.addEventListener('pointercancel', end);
    k.addEventListener('dblclick', () => { setT(valToPos(pr, pr.def)); pendingCommit = true; });
    el.appendChild(k);
  });
}
buildKnobs($('bankA'), [BRUSH].concat(CONTROLS.slice(0, 7)), 0);
buildKnobs($('bankB'), CONTROLS.slice(7), 7);

/* --------------------------------------------------------------------- UI */
const ICON = {
  play:  '<svg viewBox="0 0 16 16"><path d="M3.5 2v12L14 8z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><rect x="3" y="2.5" width="3.6" height="11" fill="currentColor"/><rect x="9.4" y="2.5" width="3.6" height="11" fill="currentColor"/></svg>',
  undo:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5.5 3 2.5 6l3 3"/><path d="M2.5 6h7a4 4 0 0 1 0 8H7"/></svg>',
  redo:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10.5 3l3 3-3 3"/><path d="M13.5 6h-7a4 4 0 0 0 0 8H9"/></svg>',
  up:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 11V2.5M4.5 6 8 2.5 11.5 6M3 14h10"/></svg>',
  down:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 2V10.5M4.5 7 8 10.5 11.5 7M3 14h10"/></svg>',
  axes:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="3"/><path d="M8 1v4M8 11v4M1 8h4M11 8h4M3 3l2.2 2.2M10.8 10.8 13 13M13 3l-2.2 2.2M5.2 10.8 3 13"/></svg>',
  info:  '<svg viewBox="0 0 16 16"><rect x="7" y="2.5" width="2" height="2" fill="currentColor"/><rect x="7" y="6.5" width="2" height="7" fill="currentColor"/></svg>',
};
$('upBtn').innerHTML = ICON.up; $('downBtn').innerHTML = ICON.down; $('undoBtn').innerHTML = ICON.undo; $('redoBtn').innerHTML = ICON.redo; $('infoBtn').innerHTML = ICON.info; $('axesBtn').innerHTML = ICON.axes;
const axLabels = CONTROLS.map(c => { const e = document.createElement('span'); e.textContent = c.label; $('axLabels').appendChild(e); return e; });
function toggleAxes(){ S.axes = !S.axes; spokes.visible = S.axes; $('axLabels').hidden = !S.axes; $('axesBtn').classList.toggle('on', S.axes); }
$('axesBtn').addEventListener('click', toggleAxes);
$('upBtn').addEventListener('click', () => { initAudio(); $('fileIn').click(); });
$('fileIn').addEventListener('change', e => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; });
$('playBtn').addEventListener('click', togglePlay);
function placePop(pop, btn){
  const sr = stage.getBoundingClientRect(), br = btn.getBoundingClientRect();
  pop.style.top = (br.bottom - sr.top) + 'px';
  pop.style.left = (br.left - sr.left) + 'px'; pop.style.width = br.width + 'px';
}
function closePops(){ for (const id of ['colPop','dlPop']) $(id).hidden = true; $('colBtn').classList.remove('open'); $('downBtn').classList.remove('open'); }
function openDownload(){
  const wasOpen = !$('dlPop').hidden; closePops(); if (wasOpen) return;
  const pl = exportPlan(), f = v => v.toFixed(v < 10 ? 2 : 1) + ' s';
  $('dlPop').innerHTML =
    `<button data-m="one" title="One ${pl.gatedNow ? 'note' : 'pass'} · ${f(pl.one)}" aria-label="Download one ${pl.gatedNow ? 'note' : 'pass'}">1×</button>` +
    `<button data-m="loop" title="Seamless loop · ${f(pl.loop)}" aria-label="Download a 4× loop">4×</button>`;
  placePop($('dlPop'), $('downBtn')); $('dlPop').hidden = false; $('downBtn').classList.add('open');
}
$('downBtn').addEventListener('click', e => { e.stopPropagation(); openDownload(); });
$('dlPop').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; closePops(); exportWav(b.dataset.m); });
document.addEventListener('pointerdown', e => { if (!e.target.closest('.pop,#colBtn,#downBtn')) closePops(); });
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);
document.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });

const bar = $('bar'), dot = $('dot'), fill = $('fill');
let barDrag = false;
const barSeek = e => { const r = bar.getBoundingClientRect(); seek((e.clientX - r.left)/r.width); };
bar.addEventListener('pointerdown', e => { bar.setPointerCapture(e.pointerId); barDrag = true; barSeek(e); });
bar.addEventListener('pointermove', e => { if (barDrag) barSeek(e); });
bar.addEventListener('pointerup', () => barDrag = false);
bar.addEventListener('pointercancel', () => barDrag = false);

function setSample(id){
  initAudio(); S.sample = id; playPos = 0; startOff = 0;
  if (S.playing) play(); else renderUI();
}
const modal = $('modal'), mBody = $('mBody');
// panels sit over the sphere's resting outline: about half its diameter wide, three-quarters tall, same size for every panel
function placePanel(){}
function openPanel(title, html, cls){ $('mTitle').textContent = title; modal.querySelector('.panel').className = 'panel' + (cls ? ' ' + cls : ''); mBody.innerHTML = html; modal.hidden = false; placePanel(); mBody.scrollTop = 0; }
function closePanel(){ modal.hidden = true; }
$('mClose').addEventListener('click', closePanel);
modal.addEventListener('pointerdown', e => { if (!e.target.closest('button.row > span, .row.cat > span, .prose p > *, .prose p, #mTitle')) closePanel(); });

function openSounds(){
  let html = '<button class="row" data-id="__load"><span>Load file…</span></button>';
  if (fileBuf) html += `<button class="row${S.sample === 'file' ? ' sel' : ''}" data-id="file"><span>${S.fileName}</span></button>`;
  for (const [cat, list] of SOUND_GROUPS){
    html += `<div class="row cat"><span>${cat[0] + cat.slice(1).toLowerCase()}</span></div>`;
    html += list.map(([id, n]) => `<button class="row${id === S.sample ? ' sel' : ''}" data-id="${id}"><span>${n}</span></button>`).join('');
  }
  openPanel('Sounds', html);
  const sel = mBody.querySelector('.row.sel'); if (sel) sel.scrollIntoView({block:'center'});
  mBody.onclick = e => {
    const b = e.target.closest('button.row'); if (!b) return;
    if (b.dataset.id === '__load'){ closePanel(); initAudio(); $('fileIn').click(); return; }
    setSample(b.dataset.id);
    mBody.querySelectorAll('.row.sel').forEach(r => r.classList.remove('sel')); b.classList.add('sel');
  };
}
$('smpBtn').addEventListener('click', openSounds);

const row = (a, b) => `<div class="row"><span>${a}</span><span>${b}</span></div>`;
const cat = a => `<div class="row cat"><span>${a}</span></div>`;
function openInfo(){
  mBody.onclick = null;
  const k = x => `<kbd>${x}</kbd>`, b = x => `<b>${x}</b>`;
  openPanel('Info', `<div class="prose">
<p>Drag the sphere up to pull, down to push. Every knob owns a spot: pull there to raise it, push to lower it. Knobs resting at an end, like ${b('DRIVE')} or ${b('CUTOFF')}, move away from rest either way. Broad or hard strokes reach several spots at once.</p>
<p>Hover a knob to see its spot, ${k('A')} to see all of them. Drag around the sphere to rotate, ${k('⇧')} + scroll or pinch to zoom.</p>
<p>${b('BRUSH')} sets stroke size: ${k('[')} ${k(']')}, scroll, or its knob.</p>
<p>Drag knobs vertically, ${k('⇧')} for fine, double-click to reset. Grey means inactive until its partner moves. <span class="r">OVER</span> means a spot is past its range; the sound holds at the limit.</p>
<p>${k('SPACE')} play · ${k('R')} reset sphere · ${k('⌘')} ${k('Z')} undo · ${k('⇧')} ${k('⌘')} ${k('Z')} redo · ${k('ESC')} close.</p>
<p>Download ${b('1×')} renders one pass or one note. ${b('4×')} renders a seamless loop with reverb and echo tails wrapped to the start. Drop an audio file onto the sphere to load it.</p>
</div>`, 'info');
}
$('infoBtn').addEventListener('click', openInfo);

const COLOURS = ['#2ae22a','#2f63e0','#ff5a1f','#ff6fb5','#3a3a37'];   // green, blue, orange, pink, charcoal
let sphereColour = '#2ae22a';
function setColour(c){ sphereColour = c; meshMat.uniforms.uColor.value.set(c);
  const k = new THREE.Color(c).lerp(new THREE.Color(0xf7f7f4), 0.72); document.documentElement.style.setProperty('--tint', '#' + k.getHexString());
  const ac = new THREE.Color(c).lerp(new THREE.Color(0x000000), 0.28); document.documentElement.style.setProperty('--accent', '#' + ac.getHexString()); $('colBtn').innerHTML = `<i style="background:${c}"></i>`; }
function openColour(){
  const wasOpen = !$('colPop').hidden; closePops(); if (wasOpen) return;
  $('colPop').innerHTML = COLOURS.filter(c => c !== sphereColour).map(c => `<button data-c="${c}" aria-label="${c}"><i style="background:${c}"></i></button>`).join('');
  placePop($('colPop'), $('colBtn')); $('colPop').hidden = false; $('colBtn').classList.add('open');
}
$('colPop').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; setColour(b.dataset.c); closePops(); });
$('colBtn').addEventListener('click', e => { e.stopPropagation(); openColour(); });
setColour(sphereColour);

function renderUI(){
  $('playBtn').innerHTML = S.playing ? ICON.pause : ICON.play;
  $('playBtn').setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
  $('playBtn').classList.toggle('on', S.playing);
  $('downBtn').classList.toggle('busy', exporting);
  $('downBtn').setAttribute('aria-label', exporting ? 'Rendering WAV…' : 'Download WAV');
  $('smp').textContent = S.sample === 'file' ? S.fileName : SAMPLES.find(s => s[0] === S.sample)[1];
  $('undoBtn').disabled = hpos <= 0;
  $('redoBtn').disabled = hpos >= hist.length - 1;
}

addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')){ e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')){ e.preventDefault(); redo(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape'){ closePanel(); closePops(); }
  else if (e.key === ' '){ e.preventDefault(); if (!e.repeat) togglePlay(); }
  else if (e.key === 'r' || e.key === 'R') resetShape();
  else if (e.key === 'a' || e.key === 'A') toggleAxes();
  else if (e.key === '[' || e.key === ']'){ S.brush = clamp(S.brush*(e.key === ']' ? 1.15 : 1/1.15), BRUSH.min, BRUSH.max); }
});

/* -------------------------------------------------------------- render loop */
let baseDist = 4.4;
function resize(){
  if (!modal.hidden) placePanel();
  const r = stage.getBoundingClientRect();
  renderer.setSize(Math.max(1, r.width), Math.max(1, r.height), false);
  camera.aspect = r.width/Math.max(1, r.height);
  const fit = Math.min(1, camera.aspect);
  baseDist = 1/(Math.tan(camera.fov*Math.PI/360)*0.8*fit);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);

let lastT = performance.now();
function frame(now){
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastT)/1000); lastT = now;
  if (pendingKnob){ const {k, t} = pendingKnob; pendingKnob = null; setAxis(k, t); }
  if (dirty){ dirty = false; mg.computeVertexNormals(); updateFromShape(); }
  if (pendingCommit && !pendingKnob && !knobDrag && !gesture){ pendingCommit = false; commit(); }

  for (const kn of KN){
    const pr = kn.pr, v = pr === BRUSH ? S.brush : V[pr.k], txt = pr.fmt(v);
    if (kn.txt !== txt){ kn.txt = txt; kn.v.textContent = txt; }
    const t = knobDrag && knobDrag.kn === kn && pr === BRUSH ? knobDrag.t : valToPos(pr, v);
    const ang = Math.round((-135 + 270*t)*10)/10;
    if (kn.ang !== ang){ kn.ang = ang; kn.ptr.style.transform = `rotate(${ang}deg)`; }
    const idle = pr.k === 'step' ? V.legato >= 0.999 : pr.k === 'echoTime' ? V.echo < 0.01 : pr.k === 'lfoRate' ? V.lfoDepth < 0.01 : pr.k === 'reso' ? V.filter > 12000 : false;
    if (kn.idle !== idle){ kn.idle = idle; kn.el.classList.toggle('idle', idle); }
    const ov = kn.idx >= 0 && Math.abs(AXD[kn.idx]) > D + 0.004;
    if (kn.ov !== ov){ kn.ov = ov; kn.el.classList.toggle('over', ov); }
  }

  const b = curBuf(), d = b ? b.duration : 0;
  if (S.playing && d){
    if (gated){
      let last = null; const nw = ctx.currentTime;
      for (const v of voices) if (v.t <= nw && (!last || v.t > last.t)) last = v;
      playPos = last ? Math.min(d, startOff + (nw - last.t)*Math.pow(2, params.pitch/12)) % d : startOff;
    } else playPos = (playPos + dt*Math.pow(2, params.pitch/12)) % d;
  }
  const f = d ? playPos/d : 0, px = Math.round(f*bar.clientWidth);
  dot.style.left = clamp(px, 3, bar.clientWidth - 3) + 'px'; fill.style.width = px + 'px';

  updateHover();
  const dist = baseDist/cam.zoom;
  camera.position.set(0, 0, dist);
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
}

commit();
renderUI();
resize();
requestAnimationFrame(frame);
})();
