export const PROJECT_VERSION = 1;

export const EASINGS = {
  linear: (p) => p,
  easeIn: (p) => p * p * p,
  easeOut: (p) => 1 - Math.pow(1 - p, 3),
  easeInOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  backOut: (p) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
  },
  bounceOut: (p) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (p < 1 / d1) return n1 * p * p;
    if (p < 2 / d1) return n1 * (p -= 1.5 / d1) * p + 0.75;
    if (p < 2.5 / d1) return n1 * (p -= 2.25 / d1) * p + 0.9375;
    return n1 * (p -= 2.625 / d1) * p + 0.984375;
  },
  elasticOut: (p) => {
    if (p === 0 || p === 1) return p;
    return Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
  },
  step: (p) => (p < 1 ? 0 : 1),
};

export const EASE_OPTIONS = [
  ['linear', 'Linear'],
  ['easeIn', 'Acelerar'],
  ['easeOut', 'Desacelerar'],
  ['easeInOut', 'Suave'],
  ['backOut', 'Com retorno'],
  ['bounceOut', 'Quique'],
  ['elasticOut', 'Elástico'],
  ['step', 'Degrau'],
];

export const TRACK_META = {
  position: { label: 'Posição', color: '#67e8f9' },
  rotation: { label: 'Rotação', color: '#a78bfa' },
  scale: { label: 'Escala', color: '#fbbf24' },
  target: { label: 'Alvo', color: '#fb7185' },
};

export const PRIMITIVE_DEFS = [
  { id: 'box', label: 'Cubo', icon: 'cube', color: '#8b5cf6' },
  { id: 'sphere', label: 'Esfera', icon: 'sphere', color: '#22d3ee' },
  { id: 'cylinder', label: 'Cilindro', icon: 'cylinder', color: '#34d399' },
  { id: 'cone', label: 'Cone', icon: 'cone', color: '#fbbf24' },
  { id: 'torus', label: 'Toro', icon: 'torus', color: '#fb7185' },
  { id: 'plane', label: 'Plano', icon: 'plane', color: '#94a3b8' },
];

export const PRESET_DEFS = [
  { id: 'spin', label: 'Girar 360°', icon: 'rotate' },
  { id: 'float', label: 'Flutuar', icon: 'wave' },
  { id: 'bounce', label: 'Quicar', icon: 'arrowUp' },
  { id: 'pulse', label: 'Pulsar', icon: 'target' },
  { id: 'orbit', label: 'Orbitar', icon: 'orbit' },
  { id: 'entrance', label: 'Entrada', icon: 'sparkles' },
  { id: 'swing', label: 'Balançar', icon: 'rotate' },
  { id: 'shake', label: 'Tremer', icon: 'move' },
];

let counter = 0;

export function uid(prefix = 'obj') {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
}

export const roundTime = (t, precision = 3) => {
  const f = 10 ** precision;
  return Math.round(t * f) / f;
};

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function uniqueName(objects, base, excludeId = null) {
  const used = new Set(objects.filter((o) => o.id !== excludeId).map((o) => o.name));
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}

export function defaultMaterial(color = '#8b5cf6') {
  return {
    color,
    metalness: 0.35,
    roughness: 0.3,
    emissive: '#000000',
    emissiveIntensity: 0,
    opacity: 1,
    wireframe: false,
    flatShading: false,
  };
}

export function createTransform(position = [0, 1, 0]) {
  return {
    position: [...position],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
}

export function emptyKeyframes() {
  return { position: [], rotation: [], scale: [], target: [] };
}

export function createPrimitive(type, project, options = {}) {
  const def = PRIMITIVE_DEFS.find((p) => p.id === type) || PRIMITIVE_DEFS[0];
  const y = type === 'plane' ? 0.01 : type === 'torus' ? 1.2 : 1;
  const obj = {
    id: uid('mesh'),
    name: uniqueName(project.objects, options.name || def.label),
    kind: 'mesh',
    parentId: null,
    visible: true,
    castShadow: type !== 'plane',
    receiveShadow: true,
    transform: createTransform(options.position || [options.x ?? 0, y, options.z ?? 0]),
    keyframes: emptyKeyframes(),
    geometry: { type },
    material: defaultMaterial(options.color || def.color),
    light: null,
    clip: null,
    asset: null,
  };
  if (type === 'plane') {
    obj.transform.rotation = [-Math.PI / 2, 0, 0];
    obj.transform.position = [0, 0.01, 0];
  }
  return obj;
}

export function createGroup(project, options = {}) {
  return {
    id: uid('grp'),
    name: uniqueName(project.objects, options.name || 'Grupo'),
    kind: 'group',
    parentId: options.parentId || null,
    visible: true,
    castShadow: false,
    receiveShadow: false,
    transform: createTransform(options.position || [0, 0, 0]),
    keyframes: emptyKeyframes(),
    geometry: null,
    material: null,
    light: null,
    clip: null,
    asset: null,
  };
}

export function createLight(type, project, options = {}) {
  const presets = {
    directional: {
      name: 'Luz direcional',
      color: '#fff1d6',
      intensity: 3,
      distance: 0,
      angle: Math.PI / 5,
      penumbra: 0.4,
      position: [5, 8, 4],
    },
    point: {
      name: 'Luz pontual',
      color: '#7c5cff',
      intensity: 40,
      distance: 0,
      angle: Math.PI / 4,
      penumbra: 0.5,
      position: [-4, 2.5, -3],
    },
    spot: {
      name: 'Spot',
      color: '#22d3ee',
      intensity: 90,
      distance: 30,
      angle: Math.PI / 6,
      penumbra: 0.55,
      position: [4, 6, -4],
    },
  };
  const p = presets[type] || presets.point;
  return {
    id: uid('lgt'),
    name: uniqueName(project.objects, options.name || p.name),
    kind: 'light',
    parentId: null,
    visible: true,
    castShadow: type === 'directional' || type === 'spot',
    receiveShadow: false,
    transform: createTransform(options.position || p.position),
    keyframes: emptyKeyframes(),
    geometry: null,
    material: null,
    light: {
      type,
      color: options.color || p.color,
      intensity: options.intensity ?? p.intensity,
      distance: options.distance ?? p.distance,
      angle: options.angle ?? p.angle,
      penumbra: options.penumbra ?? p.penumbra,
    },
    clip: null,
    asset: null,
  };
}

export function createCamera(project, options = {}) {
  return {
    id: uid('cam'),
    name: uniqueName(project.objects, options.name || 'Câmera'),
    kind: 'camera',
    parentId: null,
    visible: true,
    castShadow: false,
    receiveShadow: false,
    transform: createTransform(options.position || [6.6, 4.4, 9.2]),
    target: options.target ? [...options.target] : [0, 1.2, 0],
    fov: options.fov || 45,
    keyframes: emptyKeyframes(),
    geometry: null,
    material: null,
    light: null,
    clip: null,
    asset: null,
  };
}

export function baseProject(name = 'Cena sem título') {
  return {
    version: PROJECT_VERSION,
    name,
    settings: {
      duration: 6,
      fps: 30,
      loop: true,
      background: '#060913',
      grid: true,
      shadows: true,
      fog: true,
      environment: 0.55,
    },
    camera: {
      position: [7.2, 4.8, 9.8],
      target: [0, 1.3, 0],
    },
    objects: [],
    nextNumber: 1,
  };
}

function addDefaultLights(project, mood = 'neon') {
  if (mood === 'neon') {
    project.objects.push(
      createLight('directional', project, {
        name: 'Sol quente',
        position: [5.5, 8.5, 4.5],
        color: '#ffedd5',
        intensity: 3.2,
      }),
      createLight('point', project, {
        name: 'Luz violeta',
        position: [-4.2, 2.6, -3.2],
        color: '#8b5cf6',
        intensity: 55,
      }),
      createLight('spot', project, {
        name: 'Rim ciano',
        position: [4.5, 6.2, -4.5],
        color: '#22d3ee',
        intensity: 120,
      }),
    );
  } else if (mood === 'studio') {
    project.objects.push(
      createLight('directional', project, {
        name: 'Softbox',
        position: [4.5, 7.5, 5.5],
        color: '#fff7ed',
        intensity: 3.6,
      }),
      createLight('point', project, {
        name: 'Preenchimento',
        position: [-4, 2.2, 3],
        color: '#bfdbfe',
        intensity: 24,
      }),
      createLight('spot', project, {
        name: 'Contraluz',
        position: [-2.5, 5.5, -4.5],
        color: '#fda4af',
        intensity: 80,
      }),
    );
  } else {
    project.objects.push(
      createLight('directional', project, {
        position: [4, 7, 4],
      }),
      createLight('point', project, {
        position: [-3, 2, -2],
      }),
    );
  }
}

function orbitKeys(radius, center, phase, duration, steps = 8, y = 0) {
  const keys = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = phase + (i / steps) * Math.PI * 2;
    keys.push({
      t: roundTime((i / steps) * duration),
      v: [center[0] + Math.cos(a) * radius, y, center[2] + Math.sin(a) * radius],
      ease: 'linear',
    });
  }
  return keys;
}

export function createTemplate(templateId = 'neon') {
  const project = baseProject();
  project.objects.push(createCamera(project, { name: 'Câmera', position: [6.6, 4.4, 9.2], target: [0, 1.25, 0] }));

  if (templateId === 'empty') {
    project.name = 'Cena vazia';
    project.settings.background = '#080b12';
    project.settings.environment = 0.4;
    project.camera = { position: [5.5, 3.8, 7], target: [0, 1, 0] };
    addDefaultLights(project, 'plain');
    return project;
  }

  if (templateId === 'showcase') {
    project.name = 'Vitrine';
    project.settings.background = '#08070d';
    project.settings.environment = 0.9;
    project.settings.duration = 8;
    project.camera = { position: [5.8, 3.6, 7.8], target: [0, 1.05, 0] };
    const camera = project.objects[0];
    camera.transform.position = [5.8, 3.4, 7.6];
    camera.target = [0, 1.05, 0];
    camera.keyframes.position = [
      { t: 0, v: [5.9, 3.4, 7.7], ease: 'easeInOut' },
      { t: 4, v: [4.2, 2.7, 6.1], ease: 'easeInOut' },
      { t: 8, v: [5.9, 3.4, 7.7], ease: 'easeInOut' },
    ];
    camera.keyframes.target = [
      { t: 0, v: [0, 1.05, 0], ease: 'easeInOut' },
      { t: 4, v: [0, 1.2, 0], ease: 'easeInOut' },
      { t: 8, v: [0, 1.05, 0], ease: 'easeInOut' },
    ];
    addDefaultLights(project, 'studio');

    const platform = createPrimitive('cylinder', project, {
      name: 'Pedestal',
      position: [0, 0.11, 0],
      color: '#121522',
    });
    platform.transform.scale = [2.4, 0.22, 2.4];
    platform.material.metalness = 0.65;
    platform.material.roughness = 0.3;
    platform.castShadow = true;
    project.objects.push(platform);

    const group = createGroup(project, { name: 'Produto', position: [0, 0, 0] });
    group.keyframes.rotation = [
      { t: 0, v: [0, 0, 0], ease: 'linear' },
      { t: 8, v: [0, Math.PI * 2, 0], ease: 'linear' },
    ];
    project.objects.push(group);

    const body = createPrimitive('cylinder', project, {
      name: 'Frasco',
      position: [0, 0.95, 0],
      color: '#f2e9da',
    });
    body.parentId = group.id;
    body.transform.scale = [0.62, 1.25, 0.62];
    body.material.metalness = 0.18;
    body.material.roughness = 0.28;
    project.objects.push(body);

    const cap = createPrimitive('cylinder', project, {
      name: 'Tampa',
      position: [0, 2.1, 0],
      color: '#171b29',
    });
    cap.parentId = group.id;
    cap.transform.scale = [0.46, 0.32, 0.46];
    cap.material.metalness = 0.9;
    cap.material.roughness = 0.2;
    project.objects.push(cap);

    const ring = createPrimitive('torus', project, {
      name: 'Anel dourado',
      position: [0, 1.42, 0],
      color: '#f5c76a',
    });
    ring.parentId = group.id;
    ring.transform.rotation = [Math.PI / 2, 0, 0];
    ring.transform.scale = [1.02, 1.02, 1.02];
    ring.material.metalness = 1;
    ring.material.roughness = 0.16;
    project.objects.push(ring);

    return project;
  }

  // Padrão: Órbita Neon
  project.name = 'Órbita Neon';
  project.settings.duration = 6;
  project.settings.background = '#05070f';
  project.settings.environment = 0.6;
  const camera = project.objects[0];
  camera.keyframes.position = [
    { t: 0, v: [6.6, 4.4, 9.2], ease: 'easeInOut' },
    { t: 3, v: [5.6, 3.8, 8], ease: 'easeInOut' },
    { t: 6, v: [6.6, 4.4, 9.2], ease: 'easeInOut' },
  ];
  addDefaultLights(project, 'neon');

  const platform = createPrimitive('cylinder', project, {
    name: 'Palco',
    position: [0, 0.09, 0],
    color: '#0b1220',
  });
  platform.transform.scale = [3.15, 0.18, 3.15];
  platform.material.metalness = 0.72;
  platform.material.roughness = 0.3;
  platform.material.emissive = '#0b2d3b';
  platform.material.emissiveIntensity = 0.18;
  platform.castShadow = false;
  project.objects.push(platform);

  const nucleus = createPrimitive('sphere', project, {
    name: 'Núcleo',
    position: [0, 1.62, 0],
    color: '#8b5cf6',
  });
  nucleus.material.metalness = 0.55;
  nucleus.material.roughness = 0.18;
  nucleus.material.emissive = '#5b21b6';
  nucleus.material.emissiveIntensity = 0.42;
  nucleus.keyframes.position = [
    { t: 0, v: [0, 1.62, 0], ease: 'easeInOut' },
    { t: 1.5, v: [0, 1.84, 0], ease: 'easeInOut' },
    { t: 3, v: [0, 1.62, 0], ease: 'easeInOut' },
    { t: 4.5, v: [0, 1.78, 0], ease: 'easeInOut' },
    { t: 6, v: [0, 1.62, 0], ease: 'easeInOut' },
  ];
  nucleus.keyframes.rotation = [
    { t: 0, v: [0, 0, 0], ease: 'linear' },
    { t: 6, v: [0, Math.PI * 2, 0], ease: 'linear' },
  ];
  nucleus.keyframes.scale = [
    { t: 0, v: [1, 1, 1], ease: 'easeInOut' },
    { t: 1.5, v: [1.05, 1.05, 1.05], ease: 'easeInOut' },
    { t: 3, v: [1, 1, 1], ease: 'easeInOut' },
    { t: 4.5, v: [1.03, 1.03, 1.03], ease: 'easeInOut' },
    { t: 6, v: [1, 1, 1], ease: 'easeInOut' },
  ];
  project.objects.push(nucleus);

  const ring = createPrimitive('torus', project, {
    name: 'Anel principal',
    position: [0, 1.62, 0],
    color: '#22d3ee',
  });
  ring.transform.rotation = [Math.PI / 2.6, 0, 0.25];
  ring.transform.scale = [1.05, 1.05, 1.05];
  ring.material.metalness = 0.35;
  ring.material.roughness = 0.28;
  ring.material.emissive = '#0891b2';
  ring.material.emissiveIntensity = 0.7;
  ring.keyframes.rotation = [
    { t: 0, v: [Math.PI / 2.6, 0, 0.25], ease: 'linear' },
    { t: 6, v: [Math.PI / 2.6, 0, 0.25 + Math.PI * 2], ease: 'linear' },
  ];
  project.objects.push(ring);

  const ring2 = createPrimitive('torus', project, {
    name: 'Anel fino',
    position: [0, 1.62, 0],
    color: '#a78bfa',
  });
  ring2.transform.rotation = [-Math.PI / 3.4, 0.5, -0.2];
  ring2.transform.scale = [1.42, 1.42, 1.42];
  ring2.material.metalness = 0.3;
  ring2.material.roughness = 0.32;
  ring2.material.emissive = '#7c3aed';
  ring2.material.emissiveIntensity = 0.6;
  ring2.keyframes.rotation = [
    { t: 0, v: [-Math.PI / 3.4, 0.5, -0.2], ease: 'linear' },
    { t: 6, v: [-Math.PI / 3.4, 0.5, -0.2 - Math.PI * 2], ease: 'linear' },
  ];
  project.objects.push(ring2);

  const satelliteColors = ['#22d3ee', '#fbbf24', '#fb7185'];
  const satelliteNames = ['Satélite ciano', 'Satélite âmbar', 'Satélite coral'];
  const heights = [0.72, 1.62, 2.48];
  const radius = 2.12;
  for (let i = 0; i < 3; i += 1) {
    const phase = (Math.PI * 2 * i) / 3;
    const cube = createPrimitive('box', project, {
      name: satelliteNames[i],
      position: [Math.cos(phase) * radius, heights[i], Math.sin(phase) * radius],
      color: satelliteColors[i],
    });
    cube.transform.rotation = [0.3, phase, 0.2];
    cube.transform.scale = [0.34, 0.34, 0.34];
    cube.material.metalness = 0.38;
    cube.material.roughness = 0.26;
    cube.material.emissive = satelliteColors[i];
    cube.material.emissiveIntensity = 0.32;
    cube.keyframes.position = orbitKeys(radius, [0, 0, 0], phase, 6, 8, 0).map((k) => ({
      ...k,
      v: [k.v[0], heights[i], k.v[2]],
    }));
    cube.keyframes.rotation = [
      { t: 0, v: [0.3, phase, 0.2], ease: 'linear' },
      { t: 6, v: [0.3 + Math.PI * 2, phase, 0.2], ease: 'linear' },
    ];
    project.objects.push(cube);
  }

  return project;
}

export function sampleTrack(keys, time) {
  if (!keys || keys.length === 0) return null;
  if (keys.length === 1) return [...keys[0].v];
  const first = keys[0];
  if (time <= first.t) return [...first.v];
  const last = keys[keys.length - 1];
  if (time >= last.t) return [...last.v];
  let a = keys[0];
  let b = keys[1];
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (time >= keys[i].t && time <= keys[i + 1].t) {
      a = keys[i];
      b = keys[i + 1];
      break;
    }
  }
  const span = b.t - a.t;
  const raw = span <= 1e-6 ? 1 : (time - a.t) / span;
  const ease = EASINGS[a.ease] || EASINGS.easeInOut;
  const p = ease(clamp(raw, 0, 1));
  return [
    a.v[0] + (b.v[0] - a.v[0]) * p,
    a.v[1] + (b.v[1] - a.v[1]) * p,
    a.v[2] + (b.v[2] - a.v[2]) * p,
  ];
}

export function keyframeAt(keys, time, epsilon = 0.001) {
  return keys.find((k) => Math.abs(k.t - time) <= epsilon) || null;
}

export function upsertKeyframe(keys, time, value, ease = 'easeInOut') {
  const t = roundTime(time);
  let key = keyframeAt(keys, t);
  if (key) {
    key.v = [...value];
    key.ease = ease;
  } else {
    key = { t, v: [...value], ease };
    keys.push(key);
  }
  keys.sort((a, b) => a.t - b.t);
  return key;
}

export function sortKeys(keys) {
  keys.sort((a, b) => a.t - b.t);
  return keys;
}

export function removeKeyframe(keys, ref) {
  const i = keys.indexOf(ref);
  if (i >= 0) keys.splice(i, 1);
}

export function trackHasKeys(object, track) {
  return Array.isArray(object.keyframes?.[track]) && object.keyframes[track].length > 0;
}

export function objectIsAnimated(object) {
  return Object.keys(TRACK_META).some((track) => trackHasKeys(object, track));
}

export function applyPreset(object, presetId, duration) {
  const d = Math.max(1, Number(duration) || 6);
  const p = object.transform.position;
  const r = object.transform.rotation;
  const s = object.transform.scale;
  const pos = () => [...p];
  const rot = () => [...r];
  const sca = () => [...s];

  switch (presetId) {
    case 'spin':
      object.keyframes.rotation = [
        { t: 0, v: rot(), ease: 'linear' },
        { t: d, v: [r[0], r[1] + Math.PI * 2, r[2]], ease: 'linear' },
      ];
      break;
    case 'float': {
      const amp = Math.max(0.18, 0.26 * Math.abs(s[1]));
      object.keyframes.position = [
        { t: 0, v: pos(), ease: 'easeInOut' },
        { t: d * 0.25, v: [p[0], p[1] + amp, p[2]], ease: 'easeInOut' },
        { t: d * 0.5, v: [...p], ease: 'easeInOut' },
        { t: d * 0.75, v: [p[0], p[1] + amp * 0.75, p[2]], ease: 'easeInOut' },
        { t: d, v: [...p], ease: 'easeInOut' },
      ];
      break;
    }
    case 'bounce': {
      const amp = Math.max(0.5, 1.1 * Math.abs(s[1]));
      object.keyframes.position = [
        { t: 0, v: pos(), ease: 'easeOut' },
        { t: d * 0.18, v: [p[0], p[1] + amp, p[2]], ease: 'easeIn' },
        { t: d * 0.36, v: [...p], ease: 'easeOut' },
        { t: d * 0.52, v: [p[0], p[1] + amp * 0.45, p[2]], ease: 'easeIn' },
        { t: d * 0.66, v: [...p], ease: 'easeOut' },
        { t: d * 0.78, v: [p[0], p[1] + amp * 0.16, p[2]], ease: 'easeIn' },
        { t: d * 0.88, v: [...p], ease: 'easeOut' },
        { t: d, v: [p[0], p[1] + 0.02, p[2]], ease: 'easeInOut' },
      ];
      break;
    }
    case 'pulse': {
      const keys = [];
      const steps = 8;
      for (let i = 0; i <= steps; i += 1) {
        const wave = Math.sin((i / steps) * Math.PI * 2);
        const k = 1 + 0.14 * wave;
        keys.push({ t: roundTime((i / steps) * d), v: [s[0] * k, s[1] * k, s[2] * k], ease: 'easeInOut' });
      }
      object.keyframes.scale = keys;
      break;
    }
    case 'orbit': {
      const radius = Math.max(1.1, Math.hypot(p[0], p[2]));
      const phase = Math.atan2(p[2], p[0]);
      object.keyframes.position = orbitKeys(radius, [0, 0, 0], phase, d, 8, p[1]);
      break;
    }
    case 'entrance': {
      object.keyframes.scale = [
        { t: 0, v: [s[0] * 0.01, s[1] * 0.01, s[2] * 0.01], ease: 'backOut' },
        { t: d * 0.3, v: [s[0] * 1.08, s[1] * 1.08, s[2] * 1.08], ease: 'easeInOut' },
        { t: d * 0.42, v: [...s], ease: 'easeInOut' },
        { t: d, v: [...s], ease: 'linear' },
      ];
      object.keyframes.position = [
        { t: 0, v: [p[0], p[1] + Math.max(1.2, 2.2 * Math.abs(s[1])), p[2]], ease: 'backOut' },
        { t: d * 0.42, v: [...p], ease: 'linear' },
        { t: d, v: [...p], ease: 'linear' },
      ];
      break;
    }
    case 'swing': {
      const amp = 0.28;
      object.keyframes.rotation = [
        { t: 0, v: rot(), ease: 'easeInOut' },
        { t: d * 0.25, v: [r[0], r[1], r[2] + amp], ease: 'easeInOut' },
        { t: d * 0.5, v: [r[0], r[1], r[2] - amp], ease: 'easeInOut' },
        { t: d * 0.75, v: [r[0], r[1], r[2] + amp * 0.6], ease: 'easeInOut' },
        { t: d, v: rot(), ease: 'easeInOut' },
      ];
      break;
    }
    case 'shake': {
      const keys = [];
      const steps = 12;
      for (let i = 0; i <= steps; i += 1) {
        const decay = 1 - i / steps;
        const ox = Math.sin(i * 2.7) * 0.075 * decay;
        const oy = Math.cos(i * 3.4) * 0.05 * decay;
        keys.push({
          t: roundTime((i / steps) * d),
          v: [p[0] + ox, p[1] + oy, p[2] + Math.sin(i * 4.1) * 0.05 * decay],
          ease: 'linear',
        });
      }
      object.keyframes.position = keys;
      break;
    }
    default:
      break;
  }
  return object;
}

export function setTransformFromArray(object, prop, value) {
  object.transform[prop] = value.map((n) => Number(n) || 0);
}

export function cloneObjectTree(project, sourceId) {
  const source = project.objects.find((o) => o.id === sourceId);
  if (!source) return [];
  const group = [];
  const cloneOne = (obj, parentId) => {
    const copy = structuredClone(obj);
    copy.id = uid(obj.kind === 'mesh' ? 'mesh' : obj.kind === 'light' ? 'lgt' : obj.kind === 'camera' ? 'cam' : 'grp');
    copy.parentId = parentId;
    copy.name = uniqueName(project.objects, obj.name);
    project.objects.push(copy);
    group.push(copy);
    project.objects.filter((o) => o.parentId === obj.id).forEach((child) => cloneOne(child, copy.id));
    return copy;
  };
  cloneOne(source, source.parentId);
  return group;
}

export function descendantIds(project, id) {
  const out = [id];
  for (let i = 0; i < out.length; i += 1) {
    project.objects.filter((o) => o.parentId === out[i]).forEach((o) => out.push(o.id));
  }
  return out;
}

export function isDescendant(project, candidateId, ancestorId) {
  let current = project.objects.find((o) => o.id === candidateId);
  while (current && current.parentId) {
    if (current.parentId === ancestorId) return true;
    current = project.objects.find((o) => o.id === current.parentId);
  }
  return false;
}
