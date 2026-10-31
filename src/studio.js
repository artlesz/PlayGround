import { Engine } from './engine.js';
import {
  EASE_OPTIONS,
  PRESET_DEFS,
  PRIMITIVE_DEFS,
  PROJECT_VERSION,
  TRACK_META,
  applyPreset as applyPresetToObject,
  baseProject,
  clamp,
  cloneObjectTree,
  createCamera,
  createGroup,
  createLight,
  createPrimitive,
  createTemplate,
  createTransform,
  defaultMaterial,
  descendantIds,
  emptyKeyframes,
  isDescendant,
  objectIsAnimated,
  removeKeyframe,
  roundTime,
  sortKeys,
  trackHasKeys,
  uid,
  uniqueName,
  upsertKeyframe,
} from './model.js';
import { icon, presetIcon, primitiveIcon, typeIcon } from './icons.js';

const STORAGE_KEY = 'prisma3d.project.v1';
const HISTORY_LIMIT = 32;
const TYPE_LABEL = {
  mesh: 'Objeto 3D',
  group: 'Grupo',
  light: 'Luz',
  camera: 'Câmera',
  imported: 'Modelo importado',
};
const TYPE_COLOR = {
  mesh: '#67e8f9',
  group: '#a78bfa',
  light: '#fbbf24',
  camera: '#fb7185',
  imported: '#34d399',
};
const BG_PRESETS = ['#05070f', '#0b0710', '#101722', '#050505', '#1a2230'];
const TRACKS = ['position', 'rotation', 'scale'];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmt(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return String(Number(n.toFixed(digits)));
}

function fmtDeg(rad) {
  return fmt((Number(rad) || 0) * (180 / Math.PI), 1);
}

function slugify(value) {
  return (
    String(value || 'prisma-3d')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'prisma-3d'
  );
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatTimecode(time, fps) {
  const safeFps = Math.max(1, Number(fps) || 30);
  const total = Math.max(0, Math.round(Number(time) * safeFps));
  const frames = total % safeFps;
  const seconds = Math.floor(total / safeFps) % 60;
  const minutes = Math.floor(total / (safeFps * 60));
  return `${pad2(minutes)}:${pad2(seconds)}:${pad2(frames)}`;
}

function formatSeconds(value) {
  return `${Number(value).toFixed(1).replace('.', ',')}s`;
}

function isTypingTarget(target) {
  return !!(target && target.closest && target.closest('input, textarea, select, [contenteditable="true"]'));
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function pickRecordingMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = [
    ['video/webm;codecs=vp9', 'webm'],
    ['video/webm;codecs=vp8', 'webm'],
    ['video/webm', 'webm'],
    ['video/mp4;codecs=avc1', 'mp4'],
    ['video/mp4', 'mp4'],
  ];
  for (const [mime, ext] of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return { mime, ext };
  }
  return { mime: '', ext: 'webm' };
}

function cleanKeys(list) {
  if (!Array.isArray(list)) return [];
  const validEase = new Set(EASE_OPTIONS.map(([id]) => id));
  return list
    .filter((key) => key && Number.isFinite(Number(key.t)) && Array.isArray(key.v))
    .map((key) => ({
      t: roundTime(clamp(Number(key.t), 0, 600)),
      v: [Number(key.v[0]) || 0, Number(key.v[1]) || 0, Number(key.v[2]) || 0],
      ease: validEase.has(key.ease) ? key.ease : 'easeInOut',
    }))
    .sort((a, b) => a.t - b.t);
}

function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.objects)) {
    throw new Error('Arquivo de projeto inválido.');
  }
  const project = baseProject(String(raw.name || 'Cena sem título').slice(0, 80));
  project.version = PROJECT_VERSION;
  const settings = raw.settings || {};
  project.settings = {
    ...project.settings,
    ...settings,
    duration: clamp(Number(settings.duration) || project.settings.duration, 1, 120),
    fps: [24, 30, 60].includes(Number(settings.fps)) ? Number(settings.fps) : 30,
    loop: settings.loop !== false,
    grid: settings.grid !== false,
    shadows: settings.shadows !== false,
    fog: settings.fog !== false,
    environment: clamp(Number(settings.environment ?? 0.55), 0, 2),
    background: /^#[0-9a-f]{6}$/i.test(settings.background || '') ? settings.background : '#060913',
  };
  const cam = raw.camera || {};
  project.camera = {
    position: [Number(cam.position?.[0]) || 7.2, Number(cam.position?.[1]) || 4.8, Number(cam.position?.[2]) || 9.8],
    target: [Number(cam.target?.[0]) || 0, Number(cam.target?.[1]) || 1.3, Number(cam.target?.[2]) || 0],
  };
  const ids = new Set();
  project.objects = raw.objects
    .filter((obj) => obj && typeof obj === 'object')
    .map((obj) => {
      const kind = ['mesh', 'group', 'light', 'camera', 'imported'].includes(obj.kind) ? obj.kind : 'mesh';
      let id = typeof obj.id === 'string' ? obj.id : uid(kind);
      while (ids.has(id)) id = uid(kind);
      ids.add(id);
      const transform = obj.transform || {};
      const vec = (value, fallback) => [
        Number(value?.[0] ?? fallback[0]) || 0,
        Number(value?.[1] ?? fallback[1]) || 0,
        Number(value?.[2] ?? fallback[2]) || 0,
      ];
      const geometryTypes = new Set(PRIMITIVE_DEFS.map((p) => p.id));
      const geometry =
        kind === 'mesh'
          ? { type: geometryTypes.has(obj.geometry?.type) ? obj.geometry.type : 'box' }
          : null;
      const lightPreset =
        kind === 'light'
          ? createLight(['directional', 'point', 'spot'].includes(obj.light?.type) ? obj.light.type : 'point', { objects: [] })
          : null;
      return {
        ...obj,
        id,
        kind,
        name: String(obj.name || TYPE_LABEL[kind] || 'Objeto').slice(0, 80),
        parentId: typeof obj.parentId === 'string' ? obj.parentId : null,
        visible: obj.visible !== false,
        castShadow: obj.castShadow !== false,
        receiveShadow: obj.receiveShadow !== false,
        transform: {
          position: vec(transform.position, [0, 1, 0]),
          rotation: vec(transform.rotation, [0, 0, 0]),
          scale: vec(transform.scale, [1, 1, 1]),
        },
        keyframes: {
          position: cleanKeys(obj.keyframes?.position),
          rotation: cleanKeys(obj.keyframes?.rotation),
          scale: cleanKeys(obj.keyframes?.scale),
          target: cleanKeys(obj.keyframes?.target),
        },
        geometry,
        material: kind === 'mesh' ? { ...defaultMaterial(), ...(obj.material || {}) } : null,
        light:
          kind === 'light'
            ? {
                ...lightPreset.light,
                ...(obj.light || {}),
                type: ['directional', 'point', 'spot'].includes(obj.light?.type) ? obj.light.type : 'point',
              }
            : null,
        clip:
          kind === 'imported' && obj.clip
            ? {
                index: Math.max(0, Number(obj.clip.index) || 0),
                enabled: obj.clip.enabled !== false,
                speed: clamp(Number(obj.clip.speed) || 1, 0.1, 4),
                loop: obj.clip.loop !== false,
              }
            : null,
        asset:
          kind === 'imported' && obj.asset && typeof obj.asset.data === 'string'
            ? {
                id: String(obj.asset.id || uid('asset')),
                name: String(obj.asset.name || 'modelo.glb'),
                data: obj.asset.data,
                animations: Array.isArray(obj.asset.animations) ? obj.asset.animations : [],
              }
            : null,
        target:
          kind === 'camera'
            ? vec(obj.target, [0, 1.2, 0])
            : undefined,
        fov: kind === 'camera' ? clamp(Number(obj.fov) || 45, 15, 110) : undefined,
      };
    });
  for (const obj of project.objects) {
    if (obj.parentId && !project.objects.some((o) => o.id === obj.parentId && o.kind !== 'camera')) {
      obj.parentId = null;
    }
  }
  // Remove imported entries that lost their payload.
  project.objects = project.objects.filter((obj) => obj.kind !== 'imported' || obj.asset);
  return project;
}

function defaultSelection(project) {
  return (
    project.objects.find((o) => o.name === 'Núcleo') ||
    project.objects.find((o) => o.kind === 'group' && objectIsAnimated(o)) ||
    project.objects.find((o) => o.kind === 'mesh') ||
    project.objects.find((o) => o.kind !== 'camera') ||
    null
  );
}

function nodeColor(obj) {
  if (!obj) return TYPE_COLOR.mesh;
  if (obj.kind === 'mesh') return obj.material?.color || TYPE_COLOR.mesh;
  return TYPE_COLOR[obj.kind] || TYPE_COLOR.mesh;
}

function tracksFor(obj) {
  if (!obj) return [];
  if (obj.kind === 'camera') return ['position', 'target'];
  if (obj.kind === 'light') return ['position'];
  return TRACKS;
}

function trackValue(obj, track) {
  if (track === 'target') return [...(obj.target || [0, 0, 0])];
  return [...(obj.transform?.[track] || [0, 0, 0])];
}

function totalKeys(obj) {
  if (!obj) return 0;
  return tracksFor(obj).reduce((sum, track) => sum + (obj.keyframes?.[track]?.length || 0), 0);
}

export class Studio {
  constructor() {
    this.refs = {};
    this.project = null;
    this.engine = null;
    this.selectedId = null;
    this.selectedKey = null;
    this.time = 0;
    this.playing = false;
    this.speed = 1;
    this.autoKey = false;
    this.zoom = 1;
    this.history = [];
    this.historyIndex = -1;
    this.restoring = false;
    this.restoreToken = 0;
    this.recording = null;
    this.recordingActive = false;
    this.recordFinishTimer = null;
    this.saveTimer = null;
    this.storageWarned = false;
    this.search = '';
    this.collapsed = new Set();
    this.lastFrame = 0;
    this.frameCount = 0;
    this.fpsElapsed = 0;
    this.lastInspectorSync = 0;
    this.lastTickStats = 0;
    this.initialized = false;
    this.busy = false;
    this.resizeTimer = null;
    this.modalOpen = false;
    this.live = false;
  }

  cacheRefs() {
    const ids = [
      'projectName', 'saveState', 'undoBtn', 'redoBtn', 'newBtn', 'openBtn', 'saveBtn',
      'exportBtn', 'exportCaret', 'exportMenu', 'helpBtn', 'mobileSceneBtn', 'mobilePropsBtn',
      'scenePanel', 'propsPanel', 'panelSceneClose', 'panelPropsClose', 'drawerBackdrop',
      'objectCount', 'objectSearch', 'sceneTree', 'addBtn', 'addMenu', 'shapeGrid', 'importBtn',
      'presetGrid', 'viewport', 'dropOverlay', 'recordHud', 'recordTime', 'stopRecordBtn',
      'loadingOverlay', 'modeTranslate', 'modeRotate', 'modeScale', 'spaceBtn', 'spaceLabel',
      'gridBtn', 'focusBtn', 'liveCamBtn', 'hintText', 'fpsStat', 'triStat', 'inspector',
      'selectionBadge', 'jumpStartBtn', 'prevFrameBtn', 'playBtn', 'nextFrameBtn', 'jumpEndBtn',
      'timeReadout', 'durationReadout', 'loopBtn', 'autokeyBtn', 'speedSelect', 'addKeyBtn',
      'easeSelect', 'deleteKeyBtn', 'zoomOutBtn', 'zoomInBtn', 'zoomLabel', 'durationInput',
      'fpsSelect', 'gridToggle', 'shadowToggle', 'timelineTip', 'trackObjectName', 'trackLabels',
      'timelineScroll', 'timelineInner', 'ruler', 'trackRows', 'playhead', 'trackEmpty', 'toasts',
      'modalRoot', 'projectFileInput', 'modelFileInput',
    ];
    for (const id of ids) this.refs[id] = document.getElementById(id);
  }

  setupStaticIcons() {
    const map = {
      undoBtn: 'undo',
      redoBtn: 'redo',
      helpBtn: 'help',
      mobileSceneBtn: 'layers',
      mobilePropsBtn: 'sliders',
      panelSceneClose: 'close',
      panelPropsClose: 'close',
      playBtn: 'play',
      deleteKeyBtn: 'trash',
      jumpStartBtn: 'skipStart',
      jumpEndBtn: 'skipEnd',
      prevFrameBtn: 'prev',
      nextFrameBtn: 'next',
    };
    for (const [key, name] of Object.entries(map)) {
      if (this.refs[key]) this.refs[key].innerHTML = icon(name, 16);
    }
    if (this.refs.exportCaret) this.refs.exportCaret.innerHTML = icon('chevronDown', 13);
    document.querySelectorAll('[data-ico]').forEach((el) => {
      if (!el.innerHTML.trim()) el.innerHTML = icon(el.dataset.ico, 16);
    });
    this.refs.easeSelect.innerHTML = EASE_OPTIONS.map(([id, label]) => `<option value="${id}">${label}</option>`).join('');
    this.refs.shapeGrid.innerHTML = PRIMITIVE_DEFS.map(
      (def) =>
        `<button class="add-chip" data-add="${def.id}"><span>${icon(def.icon, 15)}</span><span>${def.label}</span></button>`,
    ).join('');
    this.refs.presetGrid.innerHTML = PRESET_DEFS.map(
      (preset) =>
        `<button class="preset-btn" data-preset="${preset.id}" title="Aplicar ${preset.label}">${icon(preset.icon, 13)}<span>${preset.label}</span></button>`,
    ).join('');
  }

  async loadInitialProject() {
    let fresh = false;
    let project = null;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        project = normalizeProject(JSON.parse(saved));
      }
    } catch (error) {
      console.warn('Não foi possível restaurar o projeto salvo.', error);
    }
    if (!project) {
      project = createTemplate('neon');
      fresh = true;
    }
    this.project = project;
    this.selectedId = defaultSelection(project)?.id || null;
    this.time = fresh ? 0.85 : 0;
    this.setSaveState(fresh ? 'Projeto novo' : 'Salvo localmente', '');
  }

  async start() {
    this.cacheRefs();
    this.setupStaticIcons();
    await this.loadInitialProject();
    this.bindEvents();

    try {
      this.engine = new Engine(this.refs.viewport, {
        onSelect: (id) => this.select(id),
        onTransform: () => this.handleTransform(),
        onTransformCommit: () => this.handleTransformCommit(),
        onAssetError: (model, error) => {
          console.error(error);
          this.toast(`Falha ao carregar o modelo "${model.name}".`, 'error', 6000);
        },
        onOrbitStart: () => {
          document.querySelectorAll('.view-btn[data-view]').forEach((button) => button.classList.remove('active'));
        },
      });
    } catch (error) {
      this.showFatal(error);
      return;
    }

    await this.engine.build(this.project, { selectedId: this.selectedId, time: this.time });
    this.engine.applyEditorCamera(this.project.camera, true);
    this.engine.setSelection(this.selectedId);
    this.engine.applyTime(this.time);
    this.resetHistory();
    this.renderAll();
    this.updatePlayheadDom();
    this.engine.render();
    this.requestLoop();
    setTimeout(() => this.refs.loadingOverlay.classList.add('is-hidden'), 240);
    this.initialized = true;
  }

  requestLoop() {
    this.lastFrame = performance.now();
    const tick = (now) => {
      const dt = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.1) : 0;
      this.lastFrame = now;
      if (this.playing) this.advance(dt);
      this.engine.update(dt);
      this.engine.render();
      this.updateLiveStats(dt);
      this.updatePlayheadDom(now);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  updateLiveStats(dt) {
    this.frameCount += 1;
    this.fpsElapsed += dt;
    if (this.fpsElapsed < 0.55) return;
    const fps = Math.round(this.frameCount / this.fpsElapsed);
    const tris = this.engine.renderer.info.render.triangles || 0;
    this.refs.fpsStat.textContent = `${fps} fps`;
    this.refs.triStat.textContent = tris >= 1000 ? `${(tris / 1000).toFixed(1)}k tris` : `${tris} tris`;
    this.frameCount = 0;
    this.fpsElapsed = 0;
  }

  showFatal(error) {
    console.error(error);
    this.refs.loadingOverlay.innerHTML = `
      <div class="empty-state" style="max-width:420px">
        <div class="empty-icon">${icon('info', 22)}</div>
        <h3>Não foi possível iniciar o WebGL</h3>
        <p>O seu navegador não disponibilizou aceleração gráfica. Tente atualizar o navegador, ativar o WebGL ou abrir em outro dispositivo.</p>
      </div>`;
    this.refs.loadingOverlay.classList.remove('is-hidden');
    this.toast('WebGL indisponível neste navegador.', 'error', 7000);
  }

  selectedObject() {
    if (!this.project || !this.selectedId) return null;
    return this.project.objects.find((object) => object.id === this.selectedId) || null;
  }

  bindEvents() {
    const r = this.refs;

    r.undoBtn.addEventListener('click', () => this.undo());
    r.redoBtn.addEventListener('click', () => this.redo());
    r.newBtn.addEventListener('click', () => this.openTemplates());
    r.openBtn.addEventListener('click', () => r.projectFileInput.click());
    r.saveBtn.addEventListener('click', () => this.saveProject());
    r.exportBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleExportMenu();
    });
    r.exportMenu.addEventListener('click', (event) => {
      const item = event.target.closest('[data-export]');
      if (!item) return;
      this.toggleExportMenu(false);
      this.handleExport(item.dataset.export);
    });
    r.helpBtn.addEventListener('click', () => this.showHelp());
    r.mobileSceneBtn.addEventListener('click', () => this.openDrawer('scene'));
    r.mobilePropsBtn.addEventListener('click', () => this.openDrawer('props'));
    r.panelSceneClose.addEventListener('click', () => this.closeDrawers());
    r.panelPropsClose.addEventListener('click', () => this.closeDrawers());
    r.drawerBackdrop.addEventListener('click', () => this.closeDrawers());

    r.projectName.addEventListener('input', () => {
      if (!this.project) return;
      this.project.name = r.projectName.value.slice(0, 80);
    });
    r.projectName.addEventListener('change', () => {
      if (!this.project) return;
      if (!this.project.name.trim()) {
        this.project.name = 'Cena sem título';
        r.projectName.value = this.project.name;
      }
      this.pushHistory();
    });

    r.objectSearch.addEventListener('input', () => {
      this.search = r.objectSearch.value;
      this.renderTree();
    });

    r.addBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const hidden = r.addMenu.hidden;
      r.addMenu.hidden = !hidden;
      r.addBtn.classList.toggle('open', hidden);
      r.addBtn.setAttribute('aria-expanded', String(hidden));
    });
    r.addMenu.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-add]');
      if (!chip) return;
      r.addMenu.hidden = true;
      r.addBtn.classList.remove('open');
      r.addBtn.setAttribute('aria-expanded', 'false');
      this.addObject(chip.dataset.add);
    });

    r.importBtn.addEventListener('click', () => r.modelFileInput.click());
    document.querySelectorAll('[data-mobile-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.mobileAction;
        if (action === 'new') this.openTemplates();
        else if (action === 'open') r.projectFileInput.click();
        else if (action === 'save') this.saveProject();
      });
    });
    r.modelFileInput.addEventListener('change', () => {
      const file = r.modelFileInput.files?.[0];
      r.modelFileInput.value = '';
      if (file) this.importModel(file);
    });
    r.projectFileInput.addEventListener('change', () => {
      const file = r.projectFileInput.files?.[0];
      r.projectFileInput.value = '';
      if (file) this.openProjectFile(file);
    });

    r.presetGrid.addEventListener('click', (event) => {
      const button = event.target.closest('[data-preset]');
      if (button) this.applyPresetSelected(button.dataset.preset);
    });

    r.sceneTree.addEventListener('click', (event) => {
      const eye = event.target.closest('.tree-eye');
      if (eye) {
        event.stopPropagation();
        this.toggleVisibility(eye.dataset.id);
        return;
      }
      const caret = event.target.closest('.tree-caret');
      if (caret) {
        event.stopPropagation();
        const id = caret.dataset.caret;
        if (this.collapsed.has(id)) this.collapsed.delete(id);
        else this.collapsed.add(id);
        this.renderTree();
        return;
      }
      const row = event.target.closest('.tree-row');
      if (row) this.select(row.dataset.id);
    });
    r.sceneTree.addEventListener('dblclick', (event) => {
      const name = event.target.closest('.tree-name');
      const row = event.target.closest('.tree-row');
      if (name && row) this.startTreeRename(row.dataset.id, name);
    });
    r.sceneTree.addEventListener('keydown', (event) => {
      const row = event.target.closest('.tree-row');
      if (!row) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.select(row.dataset.id);
      }
      if (event.key === 'F2') {
        event.preventDefault();
        const name = row.querySelector('.tree-name');
        if (name) this.startTreeRename(row.dataset.id, name);
      }
    });

    const modeButtons = [r.modeTranslate, r.modeRotate, r.modeScale];
    modeButtons.forEach((button) => {
      button.addEventListener('click', () => this.setTransformMode(button.dataset.mode));
    });
    r.spaceBtn.addEventListener('click', () => this.toggleSpace());
    r.gridBtn.addEventListener('click', () => this.toggleSetting('grid'));
    r.focusBtn.addEventListener('click', () => this.focusSelected());
    r.liveCamBtn.addEventListener('click', () => this.setLiveCamera(!this.live));
    document.querySelectorAll('.viewport-toolbar [data-view]').forEach((button) => {
      button.addEventListener('click', () => this.setView(button.dataset.view, button));
    });

    r.inspector.addEventListener('focusin', (event) => {
      const field = event.target.closest('[data-field]');
      if (!field) return;
      if (field.dataset.field?.startsWith('transform.')) this.captureRuntimeTransform();
    });
    r.inspector.addEventListener('input', (event) => {
      const hero = event.target.closest('[data-hero-name]');
      if (hero) {
        this.renameSelected(hero.value, false);
        return;
      }
      const field = event.target.closest('[data-field]');
      if (field) this.applyInspectorField(field, 'input');
    });
    r.inspector.addEventListener('change', (event) => {
      const hero = event.target.closest('[data-hero-name]');
      if (hero) {
        this.renameSelected(hero.value, true);
        return;
      }
      const field = event.target.closest('[data-field]');
      if (field) this.applyInspectorField(field, 'change');
    });
    r.inspector.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]');
      if (action) {
        this.handleInspectorAction(action.dataset.action, action);
        return;
      }
      const bg = event.target.closest('[data-bg]');
      if (bg) {
        this.setBackground(bg.dataset.bg);
      }
    });

    r.jumpStartBtn.addEventListener('click', () => this.jumpTo('start'));
    r.jumpEndBtn.addEventListener('click', () => this.jumpTo('end'));
    r.prevFrameBtn.addEventListener('click', () => this.stepFrame(-1));
    r.nextFrameBtn.addEventListener('click', () => this.stepFrame(1));
    r.playBtn.addEventListener('click', () => this.togglePlay());
    r.loopBtn.addEventListener('click', () => this.toggleLoop());
    r.autokeyBtn.addEventListener('click', () => this.toggleAutoKey());
    r.speedSelect.addEventListener('change', () => {
      this.speed = Number(r.speedSelect.value) || 1;
    });
    r.addKeyBtn.addEventListener('click', () => this.addAllKeys());
    r.deleteKeyBtn.addEventListener('click', () => this.deleteSelectedKey());
    r.easeSelect.addEventListener('change', () => this.setKeyEase(r.easeSelect.value));
    r.zoomInBtn.addEventListener('click', () => this.setZoom(this.zoom + 0.5));
    r.zoomOutBtn.addEventListener('click', () => this.setZoom(this.zoom - 0.5));
    r.durationInput.addEventListener('change', () => this.setDuration(Number(r.durationInput.value)));
    r.fpsSelect.addEventListener('change', () => this.setFps(Number(r.fpsSelect.value)));
    r.gridToggle.addEventListener('change', () => this.setSetting('grid', r.gridToggle.checked));
    r.shadowToggle.addEventListener('change', () => this.setSetting('shadows', r.shadowToggle.checked));

    r.stopRecordBtn.addEventListener('click', () => this.finishRecording());

    const viewport = r.viewport;
    viewport.addEventListener('dragover', (event) => {
      event.preventDefault();
      r.dropOverlay.hidden = false;
    });
    viewport.addEventListener('dragleave', (event) => {
      if (!viewport.contains(event.relatedTarget)) r.dropOverlay.hidden = true;
    });
    viewport.addEventListener('drop', (event) => {
      event.preventDefault();
      r.dropOverlay.hidden = true;
      const file = event.dataTransfer?.files?.[0];
      if (file) this.importModel(file);
    });
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('drop', (event) => event.preventDefault());

    document.addEventListener('keydown', (event) => this.handleKeyboard(event));
    document.addEventListener('pointerdown', (event) => {
      if (!event.target.closest('.add-area')) {
        r.addMenu.hidden = true;
        r.addBtn.classList.remove('open');
        r.addBtn.setAttribute('aria-expanded', 'false');
      }
      if (!event.target.closest('.menu-anchor')) this.toggleExportMenu(false);
    });

    window.addEventListener('resize', () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        if (this.project) this.renderTimeline();
      }, 160);
    });
    window.matchMedia('(max-width: 920px)').addEventListener('change', () => this.closeDrawers());

    r.modalRoot.addEventListener('click', (event) => {
      if (event.target.closest('[data-modal-close]')) {
        this.closeModal();
        return;
      }
      if (event.target.classList.contains('modal-backdrop')) this.closeModal();
    });
  }

  renderAll() {
    if (!this.project) return;
    const r = this.refs;
    r.projectName.value = this.project.name;
    r.objectCount.textContent = String(this.project.objects.length);
    this.renderTree();
    this.renderInspector();
    this.renderTimeline();
    this.syncSettingsControls();
    this.updateHistoryButtons();
    this.updatePlayButton();
    this.updateLiveButton();
    this.updatePlayheadDom();
  }

  syncSettingsControls() {
    if (!this.project) return;
    const r = this.refs;
    const settings = this.project.settings;
    r.durationInput.value = String(settings.duration);
    r.fpsSelect.value = String(settings.fps);
    r.gridToggle.checked = settings.grid !== false;
    r.shadowToggle.checked = settings.shadows !== false;
    r.durationReadout.textContent = formatSeconds(settings.duration);
    r.loopBtn.classList.toggle('active', settings.loop !== false);
    r.loopBtn.setAttribute('aria-pressed', String(settings.loop !== false));
    r.autokeyBtn.classList.toggle('active', this.autoKey);
    r.autokeyBtn.setAttribute('aria-pressed', String(this.autoKey));
    r.speedSelect.value = String(this.speed);
    r.gridBtn.classList.toggle('active', settings.grid !== false);
    r.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    r.easeSelect.disabled = !this.selectedKey;
    r.deleteKeyBtn.disabled = !this.selectedKey;
    if (this.selectedKey?.ref) r.easeSelect.value = this.selectedKey.ref.ease || 'easeInOut';
    r.timelineTip.textContent = this.selectedObject()
      ? `${this.selectedObject().name} · ${totalKeys(this.selectedObject())} keyframes`
      : 'Selecione um objeto para animar';
  }

  updateHistoryButtons() {
    if (!this.refs.undoBtn) return;
    this.refs.undoBtn.disabled = this.historyIndex <= 0;
    this.refs.redoBtn.disabled = this.historyIndex >= this.history.length - 1;
  }

  updatePlayButton() {
    if (!this.refs.playBtn) return;
    this.refs.playBtn.innerHTML = icon(this.playing ? 'pause' : 'play', 16);
    this.refs.playBtn.title = this.playing ? 'Pausar (Espaço)' : 'Reproduzir (Espaço)';
    this.refs.playBtn.setAttribute('aria-label', this.playing ? 'Pausar' : 'Reproduzir');
  }

  updateLiveButton() {
    if (!this.refs.liveCamBtn) return;
    const hasCamera = !!this.project?.objects.some((object) => object.kind === 'camera');
    this.refs.liveCamBtn.disabled = !hasCamera;
    this.refs.liveCamBtn.classList.toggle('active', this.live);
    this.refs.liveCamBtn.setAttribute('aria-pressed', String(this.live));
    if (!hasCamera) this.refs.liveCamBtn.title = 'Adicione uma câmera à cena';
  }

  setSaveState(text, kind = '') {
    if (!this.refs.saveState) return;
    this.refs.saveState.className = `save-state${kind ? ` ${kind}` : ''}`;
    this.refs.saveState.innerHTML = `<i></i>${esc(text)}`;
  }

  setHint(text) {
    if (this.refs.hintText) this.refs.hintText.textContent = text;
  }

  renderTree() {
    if (!this.refs.sceneTree) return;
    const objects = this.project?.objects || [];
    if (this.refs.objectCount) this.refs.objectCount.textContent = String(objects.length);
    const query = this.search.trim().toLowerCase();
    const byParent = new Map();
    for (const object of objects) {
      const parent = object.parentId || null;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(object);
    }

    const rowHTML = (object, depth, hasChildren) => {
      const selected = object.id === this.selectedId;
      const animated = objectIsAnimated(object) || (object.kind === 'imported' && object.clip?.enabled);
      const collapsed = this.collapsed.has(object.id);
      const typeClass = object.kind === 'mesh' ? 'is-mesh' : `is-${object.kind}`;
      const color = nodeColor(object);
      const caret = hasChildren
        ? `<button class="tree-caret" data-caret="${object.id}" title="${collapsed ? 'Expandir' : 'Recolher'}" aria-label="${collapsed ? 'Expandir' : 'Recolher'}">${icon(collapsed ? 'chevronRight' : 'chevronDown', 11)}</button>`
        : '<span class="tree-caret"></span>';
      const eye = object.visible === false
        ? `<button class="tree-eye is-off" data-id="${object.id}" title="Mostrar objeto" aria-label="Mostrar objeto">${icon('eyeOff', 13)}</button>`
        : `<button class="tree-eye" data-id="${object.id}" title="Ocultar objeto" aria-label="Ocultar objeto">${icon('eye', 13)}</button>`;
      return `<div class="tree-row ${selected ? 'selected' : ''} ${typeClass}" data-id="${object.id}" role="treeitem" aria-selected="${selected}" tabindex="0" style="padding-left:${4 + depth * 14}px;--node-color:${color}">
        ${caret}
        <span class="tree-type">${icon(typeIcon[object.kind] || 'cube', 13)}</span>
        <span class="tree-name">${esc(object.name)}</span>
        ${animated ? '<span class="anim-dot" title="Objeto animado"></span>' : ''}
        ${eye}
      </div>`;
    };

    let html = '';
    if (query) {
      const matches = objects.filter((object) => object.name.toLowerCase().includes(query));
      html = matches.map((object) => rowHTML(object, 0, false)).join('');
      if (!matches.length) html = `<div class="tree-empty">Nenhum objeto encontrado para “${esc(this.search)}”.</div>`;
    } else {
      const walk = (parentId, depth) => {
        for (const object of byParent.get(parentId) || []) {
          const children = byParent.get(object.id) || [];
          html += rowHTML(object, depth, children.length > 0);
          if (children.length && !this.collapsed.has(object.id)) walk(object.id, depth + 1);
        }
      };
      walk(null, 0);
      if (!html) html = '<div class="tree-empty">A cena está vazia.<br />Adicione uma forma para começar.</div>';
    }
    this.refs.sceneTree.innerHTML = html;
  }

  startTreeRename(id, nameEl) {
    const object = this.project.objects.find((item) => item.id === id);
    if (!object) return;
    const input = document.createElement('input');
    input.className = 'tree-name-input';
    input.value = object.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (commit) this.renameSelected(input.value, true);
      this.renderTree();
    };
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') finish(true);
      if (event.key === 'Escape') finish(false);
    });
  }

  renameSelected(value, commit = false) {
    const object = this.selectedObject();
    if (!object) return;
    const name = String(value || '').trim().slice(0, 80);
    if (!name) return;
    object.name = name;
    const entry = this.engine?.runtime.get(object.id);
    if (entry) entry.object3d.name = name;
    if (this.refs.trackObjectName) this.refs.trackObjectName.textContent = name;
    if (this.refs.selectionBadge) this.refs.selectionBadge.textContent = `${TYPE_LABEL[object.kind]} · ${name}`;
    if (commit) {
      this.pushHistory();
      this.renderTree();
      this.renderTimeline();
      this.syncSettingsControls();
    }
  }

  toggleVisibility(id) {
    const object = this.project.objects.find((item) => item.id === id);
    if (!object) return;
    object.visible = object.visible === false;
    const entry = this.engine?.runtime.get(id);
    if (entry) entry.object3d.visible = object.visible !== false;
    this.renderTree();
    if (this.selectedId === id) this.renderInspector();
    this.pushHistory();
  }

  select(id) {
    if (id && !this.project.objects.some((object) => object.id === id)) return;
    this.selectedId = id || null;
    this.selectedKey = null;
    if (this.engine) this.engine.setSelection(this.selectedId);
    this.renderTree();
    this.renderInspector();
    this.renderTimeline();
    this.syncSettingsControls();
    const object = this.selectedObject();
    if (this.refs.selectionBadge) {
      this.refs.selectionBadge.textContent = object
        ? `${TYPE_LABEL[object.kind]} · ${object.name}`
        : 'Nada selecionado';
    }
    this.setHint(
      object
        ? `${object.name} selecionado · W mover · E girar · R escalar · K keyframe`
        : 'Clique para selecionar · arraste para orbitar · scroll para zoom',
    );
    if (window.matchMedia('(max-width: 920px)').matches) this.closeDrawers();
  }

  captureRuntimeTransform() {
    const object = this.selectedObject();
    if (!object || !this.engine) return;
    if (object.kind === 'camera') {
      const position = this.engine.shotCamera.position;
      object.transform.position = [position.x, position.y, position.z];
      return;
    }
    const transform = this.engine.readTransform(object.id);
    if (transform) object.transform = transform;
  }

  handleTransform() {
    const object = this.selectedObject();
    if (!object || !this.engine) return;
    const transform = this.engine.readTransform(object.id);
    if (!transform) return;
    object.transform = transform;
    this.syncTransformInputs();
    this.engine.updateSelection();
  }

  handleTransformCommit() {
    const object = this.selectedObject();
    if (!object || !this.engine) return;
    this.handleTransform();
    if (this.maybeAutoKey(object)) {
      this.renderTimeline();
      this.refreshKeyCounts();
    }
    this.pushHistory();
  }

  refreshKeyCounts() {
    const object = this.selectedObject();
    if (!object) return;
    this.refs.inspector.querySelectorAll('[data-keycount]').forEach((el) => {
      el.textContent = String(object.keyframes?.[el.dataset.keycount]?.length || 0);
    });
  }

  openDrawer(which) {
    if (!window.matchMedia('(max-width: 920px)').matches) return;
    this.refs.scenePanel.classList.toggle('is-open', which === 'scene');
    this.refs.propsPanel.classList.toggle('is-open', which === 'props');
    this.refs.drawerBackdrop.hidden = false;
  }

  closeDrawers() {
    this.refs.scenePanel?.classList.remove('is-open');
    this.refs.propsPanel?.classList.remove('is-open');
    if (this.refs.drawerBackdrop) this.refs.drawerBackdrop.hidden = true;
  }

  toggleExportMenu(force) {
    const show = typeof force === 'boolean' ? force : this.refs.exportMenu.hidden;
    this.refs.exportMenu.hidden = !show;
    this.refs.exportBtn.setAttribute('aria-expanded', String(show));
  }

  renderInspector() {
    if (!this.refs.inspector) return;
    const object = this.selectedObject();
    if (!object) {
      this.refs.selectionBadge.textContent = 'Nada selecionado';
      this.refs.inspector.innerHTML = this.sceneInspectorHTML();
      return;
    }
    this.refs.selectionBadge.textContent = `${TYPE_LABEL[object.kind]} · ${object.name}`;
    const color = nodeColor(object);
    const deg = (value) => (Number(value) * 180) / Math.PI;
    const vec = (label, prefix, values, step = 0.1, isDeg = false) => `
      <div class="vector-field">
        <span class="vector-label">${label}</span>
        <div class="vector-inputs">
          ${values
            .map(
              (value, index) => `<label class="vec-input"><span class="axis">${'XYZ'[index]}</span><input type="number" step="${step}" value="${isDeg ? fmt(deg(value), 1) : fmt(value, 2)}" data-field="${prefix}.${index}"${isDeg ? ' data-deg="1"' : ''} /></label>`,
            )
            .join('')}
        </div>
      </div>`;
    const toggle = (label, field, checked) => `
      <div class="field-row">
        <span class="field-label">${label}</span>
        <label class="switch"><input type="checkbox" data-field="${field}" ${checked ? 'checked' : ''} /><span></span></label>
      </div>`;
    const colorRow = (label, field, value) => `
      <div class="field-row">
        <span class="field-label">${label}</span>
        <div class="color-control">
          <label class="color-swatch"><input type="color" data-field="${field}" value="${value}" /></label>
          <span class="color-hex" data-hex-for="${field}">${String(value).toUpperCase()}</span>
        </div>
      </div>`;
    const range = (label, field, value, min, max, step, chip = fmt(value, 2)) => `
      <div class="field-row">
        <span class="field-label">${label}</span>
        <div class="range-row">
          <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-field="${field}" />
          <span class="value-chip" data-chip-for="${field}">${chip}</span>
        </div>
      </div>`;

    let html = `
      <div class="inspector-hero" style="--node-color:${color}">
        <span class="hero-icon">${icon(typeIcon[object.kind] || 'cube', 18)}</span>
        <div class="hero-copy">
          <input class="hero-name" data-hero-name value="${esc(object.name)}" spellcheck="false" aria-label="Nome do objeto" />
          <span class="hero-type">${TYPE_LABEL[object.kind]}</span>
        </div>
      </div>`;

    html += `
      <section class="section">
        <div class="section-head">
          <h3>Transformação</h3>
          <button class="section-action" data-action="reset-transform">Resetar</button>
        </div>`;

    if (object.kind !== 'camera') {
      const parentOptions = this.project.objects
        .filter((candidate) => candidate.kind !== 'camera' && candidate.id !== object.id && !isDescendant(this.project, candidate.id, object.id))
        .map(
          (candidate) =>
            `<option value="${candidate.id}" ${candidate.id === object.parentId ? 'selected' : ''}>${esc(candidate.name)}</option>`,
        )
        .join('');
      html += `
        <div class="field-row">
          <span class="field-label">Pai</span>
          <select class="select-input" data-field="parentId">
            <option value="">Cena (raiz)</option>
            ${parentOptions}
          </select>
        </div>`;
    }

    html += vec('Posição', 'transform.position', object.transform.position, 0.1);
    if (object.kind === 'camera') {
      html += vec('Alvo', 'camera.target', object.target || [0, 1.2, 0], 0.1);
      html += range('Campo de visão', 'camera.fov', object.fov || 45, 15, 110, 1, `${fmt(object.fov || 45, 0)}°`);
    } else {
      html += vec('Rotação', 'transform.rotation', object.transform.rotation, 1, true);
      html += vec('Escala', 'transform.scale', object.transform.scale, 0.05);
    }
    html += `</section>`;

    if (object.kind === 'mesh') {
      const m = object.material || {};
      html += `
        <section class="section">
          <div class="section-head"><h3>Material</h3><span class="section-action">${object.geometry?.type || 'box'}</span></div>
          ${colorRow('Cor base', 'material.color', m.color || '#8b5cf6')}
          ${range('Metal', 'material.metalness', m.metalness ?? 0.35, 0, 1, 0.01)}
          ${range('Rugosidade', 'material.roughness', m.roughness ?? 0.3, 0, 1, 0.01)}
          ${colorRow('Emissivo', 'material.emissive', m.emissive || '#000000')}
          ${range('Emissão', 'material.emissiveIntensity', m.emissiveIntensity ?? 0, 0, 4, 0.05)}
          ${range('Opacidade', 'material.opacity', m.opacity ?? 1, 0.05, 1, 0.01)}
          ${toggle('Aramado', 'material.wireframe', !!m.wireframe)}
          ${toggle('Faces planas', 'material.flatShading', !!m.flatShading)}
          ${toggle('Projetar sombra', 'castShadow', object.castShadow !== false)}
          ${toggle('Receber sombra', 'receiveShadow', object.receiveShadow !== false)}
        </section>`;
    }

    if (object.kind === 'light') {
      const l = object.light || {};
      const maxIntensity = l.type === 'directional' ? 15 : l.type === 'spot' ? 350 : 250;
      html += `
        <section class="section">
          <div class="section-head"><h3>Luz</h3><span class="section-action">${l.type || 'point'}</span></div>
          ${colorRow('Cor', 'light.color', l.color || '#ffffff')}
          ${range('Intensidade', 'light.intensity', l.intensity ?? 1, 0, maxIntensity, 0.5, fmt(l.intensity ?? 1, 1))}
          ${l.type !== 'directional' ? range('Alcance', 'light.distance', l.distance ?? 0, 0, 60, 0.5, `${fmt(l.distance ?? 0, 1)}m`) : ''}
          ${l.type === 'spot' ? range('Ângulo', 'light.angle', fmt((l.angle || Math.PI / 6) * (180 / Math.PI), 1), 5, 80, 1, `${fmt((l.angle || Math.PI / 6) * (180 / Math.PI), 0)}°`) : ''}
          ${l.type === 'spot' ? range('Penumbra', 'light.penumbra', l.penumbra ?? 0.5, 0, 1, 0.01) : ''}
          ${toggle('Projetar sombra', 'castShadow', object.castShadow !== false)}
        </section>`;
    }

    if (object.kind === 'imported') {
      const clips = object.asset?.animations || [];
      const clip = object.clip || { index: 0, enabled: false, speed: 1, loop: true };
      html += `
        <section class="section">
          <div class="section-head"><h3>Modelo importado</h3><span class="section-action">${esc(object.asset?.name || 'GLB')}</span></div>`;
      if (clips.length) {
        html += `
          ${toggle('Tocar clipe', 'clip.enabled', clip.enabled !== false)}
          <div class="field-row">
            <span class="field-label">Clipe</span>
            <select class="select-input" data-field="clip.index">
              ${clips
                .map(
                  (item, index) =>
                    `<option value="${index}" ${index === (clip.index || 0) ? 'selected' : ''}>${esc(item.name)} · ${fmt(item.duration, 1)}s</option>`,
                )
                .join('')}
            </select>
          </div>
          ${range('Velocidade', 'clip.speed', clip.speed || 1, 0.1, 3, 0.1, `${fmt(clip.speed || 1, 1)}×`)}
          ${toggle('Repetir', 'clip.loop', clip.loop !== false)}`;
      } else {
        html += '<div class="empty-mini">Este modelo não tem animações embutidas. Anime a posição, rotação e escala pela linha do tempo.</div>';
      }
      html += '</section>';
    }

    if (object.kind === 'camera') {
      html += `
        <section class="section">
          <div class="section-head"><h3>Filmagem</h3></div>
          <button class="btn" style="width:100%" data-action="preview-camera">${icon('camera', 14)} Ver pela câmera</button>
          <div class="info-note">Anime a posição e o alvo da câmera com keyframes. Use a vista ao vivo para enquadrar e gravar.</div>
        </section>`;
    }

    const tracks = tracksFor(object);
    html += `
      <section class="section">
        <div class="section-head"><h3>Animação</h3><button class="section-action" data-action="key-all">Key tudo</button></div>
        <div class="key-chip-row">
          ${tracks
            .map(
              (track) =>
                `<button class="key-chip" data-action="key-track" data-track="${track}" style="--chip-color:${TRACK_META[track].color}">
                  <span class="dot"></span>${TRACK_META[track].label}<span data-keycount="${track}">${object.keyframes?.[track]?.length || 0}</span>
                </button>`,
            )
            .join('')}
        </div>
        <div class="preset-inline">
          <button class="inline-btn" data-action="clear-keys">Limpar keyframes</button>
          <button class="inline-btn" data-action="focus-object">Enquadrar objeto</button>
        </div>
      </section>`;

    html += `
      <section class="section">
        <div class="section-head"><h3>Objeto</h3></div>
        ${toggle('Visível', 'visible', object.visible !== false)}
        <div class="preset-inline" style="margin-top:9px">
          <button class="inline-btn" data-action="duplicate">${icon('copy', 12)} Duplicar</button>
          <button class="inline-btn" data-action="delete">${icon('trash', 12)} Excluir</button>
        </div>
      </section>`;

    this.refs.inspector.innerHTML = html;
  }

  sceneInspectorHTML() {
    const settings = this.project?.settings || {};
    const animated = this.project?.objects.filter((object) => objectIsAnimated(object) || object.clip?.enabled).length || 0;
    return `
      <div class="empty-state">
        <span class="empty-icon">${icon('sliders', 22)}</span>
        <h3>Propriedades da cena</h3>
        <p>Selecione um objeto no viewport ou na lista para editar material, transformação e animação.</p>
      </div>
      <section class="section">
        <div class="section-head"><h3>Aparência</h3></div>
        <div class="field-row">
          <span class="field-label">Fundo</span>
          <div class="color-control">
            <label class="color-swatch"><input type="color" data-field="settings.background" value="${settings.background || '#060913'}" /></label>
            <span class="color-hex" data-hex-for="settings.background">${String(settings.background || '#060913').toUpperCase()}</span>
          </div>
        </div>
        <div class="bg-swatches">
          ${BG_PRESETS.map(
            (color) =>
              `<button class="bg-swatch" data-bg="${color}" title="${color}" style="background:${color};${color.toLowerCase() === String(settings.background).toLowerCase() ? 'border-color:#67e8f9' : ''}"></button>`,
          ).join('')}
        </div>
        <div class="field-row" style="margin-top:9px">
          <span class="field-label">Ambiente</span>
          <div class="range-row">
            <input type="range" min="0" max="1.6" step="0.01" value="${settings.environment ?? 0.55}" data-field="settings.environment" />
            <span class="value-chip" data-chip-for="settings.environment">${fmt(settings.environment ?? 0.55, 2)}</span>
          </div>
        </div>
        ${this.sceneToggle('Névoa', 'settings.fog', settings.fog !== false)}
        ${this.sceneToggle('Grade', 'settings.grid', settings.grid !== false)}
        ${this.sceneToggle('Sombras', 'settings.shadows', settings.shadows !== false)}
      </section>
      <section class="section">
        <div class="section-head"><h3>Câmera do editor</h3></div>
        <div class="preset-inline">
          <button class="inline-btn" data-action="view" data-view="persp">Perspectiva</button>
          <button class="inline-btn" data-action="view" data-view="front">Frente</button>
          <button class="inline-btn" data-action="view" data-view="top">Topo</button>
          <button class="inline-btn" data-action="view" data-view="side">Lado</button>
        </div>
        <div class="preset-inline">
          <button class="inline-btn" data-action="reset-camera">${icon('focus', 12)} Resetar câmera</button>
          <button class="inline-btn" data-action="new-project">${icon('sparkles', 12)} Trocar cena</button>
        </div>
      </section>
      <section class="section">
        <div class="section-head"><h3>Resumo</h3></div>
        <div class="field-row"><span class="field-label">Objetos</span><span class="value-chip">${this.project?.objects.length || 0}</span></div>
        <div class="field-row"><span class="field-label">Animações</span><span class="value-chip">${animated}</span></div>
        <div class="field-row"><span class="field-label">Duração</span><span class="value-chip">${formatSeconds(settings.duration || 6)}</span></div>
        <div class="info-note">Clique no vazio do viewport a qualquer momento para voltar a estas configurações.</div>
      </section>`;
  }

  sceneToggle(label, field, checked) {
    return `
      <div class="field-row">
        <span class="field-label">${label}</span>
        <label class="switch"><input type="checkbox" data-field="${field}" ${checked ? 'checked' : ''} /><span></span></label>
      </div>`;
  }

  applyInspectorField(el, phase) {
    const field = el.dataset.field;
    if (!field) return;
    if (field === 'parentId') {
      if (phase === 'change') this.changeParent(el.value);
      return;
    }
    if (field.startsWith('settings.')) {
      this.applySceneField(field, el, phase);
      return;
    }
    const object = this.selectedObject();
    if (!object) return;

    const chip = (text) => {
      const target = el.closest('.range-row')?.querySelector('.value-chip');
      if (target) target.textContent = text;
    };

    if (field.startsWith('transform.')) {
      const [, prop, index] = field.split('.');
      let value = Number(el.value);
      if (!Number.isFinite(value)) return;
      if (prop === 'rotation') value = (value * Math.PI) / 180;
      if (prop === 'scale' && value < 0.001) value = 0.001;
      object.transform[prop][Number(index)] = value;
      if (this.playing) this.pause();
      this.engine.applyObjectState(object);
      this.engine.updateSelection();
      if (phase === 'change') {
        if (this.maybeAutoKey(object)) {
          this.renderTimeline();
          this.refreshKeyCounts();
        }
        this.pushHistory();
      }
      return;
    }

    if (field.startsWith('camera.')) {
      const [, prop, index] = field.split('.');
      if (prop === 'target') {
        const value = Number(el.value);
        if (!Number.isFinite(value)) return;
        object.target[Number(index)] = value;
        this.engine.lookAtCamera(object.target);
      } else if (prop === 'fov') {
        object.fov = clamp(Number(el.value) || 45, 15, 110);
        this.engine.shotCamera.fov = object.fov;
        this.engine.shotCamera.updateProjectionMatrix();
        chip(`${fmt(object.fov, 0)}°`);
      }
      this.engine.updateSelection();
      if (phase === 'change') {
        if (this.maybeAutoKey(object)) {
          this.renderTimeline();
          this.refreshKeyCounts();
        }
        this.pushHistory();
      }
      return;
    }

    if (field.startsWith('material.')) {
      const prop = field.split('.')[1];
      if (!object.material) return;
      if (prop === 'color' || prop === 'emissive') {
        object.material[prop] = el.value;
        const hex = el.closest('.color-control')?.querySelector('.color-hex');
        if (hex) hex.textContent = el.value.toUpperCase();
      } else if (prop === 'wireframe' || prop === 'flatShading') {
        object.material[prop] = el.checked;
      } else {
        const value = Number(el.value);
        if (!Number.isFinite(value)) return;
        object.material[prop] = value;
        chip(fmt(value, prop === 'opacity' ? 2 : 2));
      }
      this.engine.applyObjectState(object);
      if (phase === 'change') {
        this.pushHistory();
        this.renderTree();
      }
      return;
    }

    if (field.startsWith('light.')) {
      const prop = field.split('.')[1];
      if (!object.light) return;
      if (prop === 'color') {
        object.light.color = el.value;
        const hex = el.closest('.color-control')?.querySelector('.color-hex');
        if (hex) hex.textContent = el.value.toUpperCase();
      } else {
        let value = Number(el.value);
        if (!Number.isFinite(value)) return;
        if (prop === 'angle') value = (value * Math.PI) / 180;
        object.light[prop] = value;
        if (prop === 'distance') chip(`${fmt(value, 1)}m`);
        else if (prop === 'angle') chip(`${fmt((value * 180) / Math.PI, 0)}°`);
        else if (prop === 'penumbra') chip(fmt(value, 2));
        else chip(fmt(value, 1));
      }
      this.engine.applyObjectState(object);
      if (phase === 'change') this.pushHistory();
      return;
    }

    if (field.startsWith('clip.')) {
      const prop = field.split('.')[1];
      object.clip = { ...(object.clip || { index: 0, enabled: true, speed: 1, loop: true }) };
      if (prop === 'enabled' || prop === 'loop') object.clip[prop] = el.checked;
      else if (prop === 'index') object.clip.index = Number(el.value) || 0;
      else if (prop === 'speed') {
        const value = Number(el.value);
        if (!Number.isFinite(value)) return;
        object.clip.speed = value;
        chip(`${fmt(value, 1)}×`);
      }
      this.engine.setClipSettings(object.id, object.clip.index, object.clip.enabled, object.clip.speed);
      this.engine.applyTime(this.time);
      if (phase === 'change') this.pushHistory();
      return;
    }

    if (field === 'visible') {
      object.visible = el.checked;
      this.engine.applyObjectState(object);
      if (phase === 'change') {
        this.pushHistory();
        this.renderTree();
      }
      return;
    }

    if (field === 'castShadow' || field === 'receiveShadow') {
      object[field] = el.checked;
      this.engine.applyObjectState(object);
      if (phase === 'change') this.pushHistory();
    }
  }

  applySceneField(field, el, phase) {
    if (!this.project) return;
    const settings = this.project.settings;
    const prop = field.split('.')[1];
    if (prop === 'background') {
      this.setBackground(el.value, phase === 'change');
      return;
    }
    if (prop === 'environment') {
      settings.environment = clamp(Number(el.value) || 0, 0, 2);
      const chip = el.closest('.range-row')?.querySelector('.value-chip');
      if (chip) chip.textContent = fmt(settings.environment, 2);
      this.engine.applySettings(settings);
      if (phase === 'change') this.pushHistory();
      return;
    }
    if (prop === 'fog' || prop === 'grid' || prop === 'shadows') {
      settings[prop] = el.checked;
      this.engine.applySettings(settings);
      this.syncSettingsControls();
      if (phase === 'change') this.pushHistory();
    }
  }

  handleInspectorAction(action, element) {
    const object = this.selectedObject();
    switch (action) {
      case 'reset-transform':
        if (!object) return;
        object.transform.position = object.kind === 'mesh' ? [0, 1, 0] : object.kind === 'light' ? [3, 4, 3] : object.kind === 'camera' ? [6.6, 4.4, 9.2] : [0, 0, 0];
        object.transform.rotation = [0, 0, 0];
        object.transform.scale = [1, 1, 1];
        if (object.kind === 'camera') {
          object.target = [0, 1.2, 0];
          object.fov = 45;
        }
        this.engine.applyObjectState(object);
        this.engine.applyTime(this.time);
        this.pushHistory();
        this.renderInspector();
        this.renderTimeline();
        break;
      case 'key-track':
        this.addKeyframeForTrack(element.dataset.track);
        break;
      case 'key-all':
        this.addAllKeys();
        break;
      case 'clear-keys':
        this.clearKeys();
        break;
      case 'duplicate':
        this.duplicateSelected();
        break;
      case 'delete':
        this.deleteSelectedObject();
        break;
      case 'focus-object':
        this.focusSelected();
        break;
      case 'preview-camera':
        this.setLiveCamera(true);
        break;
      case 'view':
        this.setView(element.dataset.view, element);
        break;
      case 'reset-camera':
        this.engine.applyEditorCamera(this.project.camera, false);
        break;
      case 'new-project':
        this.openTemplates();
        break;
      default:
        break;
    }
  }

  maybeAutoKey(object) {
    if (!this.autoKey || !object) return false;
    const time = this.time;
    if (object.kind === 'camera') {
      upsertKeyframe(object.keyframes.position, time, object.transform.position, 'easeInOut');
      upsertKeyframe(object.keyframes.target, time, object.target, 'easeInOut');
    } else {
      for (const track of TRACKS) {
        upsertKeyframe(object.keyframes[track], time, object.transform[track], 'easeInOut');
      }
    }
    this.engine.applyTime(this.time);
    return true;
  }

  syncTransformInputs() {
    const object = this.selectedObject();
    if (!object || !this.engine || !this.refs.inspector) return;
    let source = null;
    if (object.kind === 'camera') {
      const position = this.engine.shotCamera.position;
      source = { position: [position.x, position.y, position.z], rotation: [0, 0, 0], scale: [1, 1, 1] };
    } else {
      source = this.engine.readTransform(object.id);
    }
    if (!source) return;
    const setValue = (field, value, isDeg = false) => {
      const input = this.refs.inspector.querySelector(`[data-field="${field}"]`);
      if (!input || document.activeElement === input) return;
      input.value = isDeg ? fmt((value * 180) / Math.PI, 1) : fmt(value, 2);
    };
    ['position', 'rotation', 'scale'].forEach((track) => {
      for (let i = 0; i < 3; i += 1) {
        setValue(`transform.${track}.${i}`, source[track][i], track === 'rotation');
      }
    });
    if (object.kind === 'camera') {
      for (let i = 0; i < 3; i += 1) setValue(`camera.target.${i}`, object.target[i]);
    }
  }

  changeParent(value) {
    const object = this.selectedObject();
    if (!object) return;
    if (value) {
      const parent = this.project.objects.find((candidate) => candidate.id === value);
      if (!parent || parent.kind === 'camera' || parent.id === object.id || isDescendant(this.project, parent.id, object.id)) {
        this.toast('Esse objeto não pode ser o pai selecionado.', 'error');
        this.renderInspector();
        return;
      }
    }
    object.parentId = value || null;
    this.rebuildScene().then(() => {
      this.pushHistory();
      this.toast('Hierarquia atualizada.', 'success', 1800);
    });
  }

  setBackground(value, commit = true) {
    if (!/^#[0-9a-f]{6}$/i.test(value)) return;
    this.project.settings.background = value;
    this.engine.applySettings(this.project.settings);
    const hex = document.querySelector('[data-hex-for="settings.background"]');
    if (hex) hex.textContent = value.toUpperCase();
    document.querySelectorAll('[data-bg]').forEach((swatch) => {
      swatch.style.borderColor = swatch.dataset.bg.toLowerCase() === value.toLowerCase() ? '#67e8f9' : '';
    });
    if (commit) this.pushHistory();
  }

  setSetting(key, value) {
    if (!this.project) return;
    this.project.settings[key] = value;
    this.engine.applySettings(this.project.settings);
    this.syncSettingsControls();
    this.pushHistory();
  }

  toggleSetting(key) {
    this.setSetting(key, !this.project.settings[key]);
  }

  setZoom(value) {
    this.zoom = clamp(Number(value) || 1, 0.5, 4);
    this.renderTimeline();
    this.syncSettingsControls();
  }

  setDuration(value) {
    if (!this.project) return;
    const duration = clamp(Number(value) || 6, 1, 120);
    this.project.settings.duration = duration;
    this.time = Math.min(this.time, duration);
    this.engine.applyTime(this.time);
    this.renderTimeline();
    this.syncSettingsControls();
    this.pushHistory();
  }

  setFps(value) {
    if (!this.project) return;
    this.project.settings.fps = [24, 30, 60].includes(Number(value)) ? Number(value) : 30;
    this.syncSettingsControls();
    this.updatePlayheadDom();
    this.pushHistory();
  }

  renderTimeline() {
    if (!this.refs.timelineInner || !this.project) return;
    const r = this.refs;
    const object = this.selectedObject();
    const tracks = object ? tracksFor(object) : [];
    const duration = this.project.settings.duration || 6;

    r.trackObjectName.textContent = object ? object.name : 'Animação';
    r.trackLabels.innerHTML = object
      ? tracks
          .map((track) => {
            const meta = TRACK_META[track];
            const count = object.keyframes?.[track]?.length || 0;
            return `<div class="track-label-row ${count ? 'has-keys' : ''}" style="--track-color:${meta.color}">
              <span class="track-dot"></span>
              <span class="track-name">${meta.label}</span>
              <span class="track-count">${count}</span>
              <button class="track-add" data-track-add="${track}" title="Adicionar keyframe de ${meta.label.toLowerCase()}" aria-label="Adicionar keyframe de ${meta.label.toLowerCase()}">${icon('plus', 10)}</button>
            </div>`;
          })
          .join('')
      : '';
    r.trackRows.innerHTML = object
      ? tracks
          .map(
            (track) => `<div class="track-row" data-track="${track}"><div class="row-hit" data-track-hit="${track}" title="Clique para posicionar · duplo clique para criar keyframe"></div></div>`,
          )
          .join('')
      : '';
    r.trackEmpty.hidden = !!object;

    const baseWidth = Math.max(420, duration * 100 * this.zoom);
    r.timelineInner.style.width = `${baseWidth}px`;

    this.renderRuler();

    if (object) {
      tracks.forEach((track) => {
        const row = r.trackRows.querySelector(`.track-row[data-track="${track}"]`);
        if (!row) return;
        const color = TRACK_META[track].color;
        for (const key of object.keyframes?.[track] || []) {
          if (key.t > duration + 0.0001) continue;
          const diamond = document.createElement('button');
          diamond.className = 'key-diamond';
          diamond.dataset.track = track;
          diamond.dataset.t = String(key.t);
          diamond.style.left = `${(key.t / duration) * 100}%`;
          diamond.style.setProperty('--key-color', color);
          diamond.title = `${TRACK_META[track].label} · ${key.t.toFixed(2)}s · ${key.ease}`;
          diamond.setAttribute('aria-label', diamond.title);
          if (this.selectedKey && this.selectedKey.track === track && this.selectedKey.ref === key) {
            diamond.classList.add('selected');
          }
          diamond.addEventListener('pointerdown', (event) => this.startKeyDrag(event, key, track, diamond));
          row.appendChild(diamond);
        }
        const hit = row.querySelector('.row-hit');
        hit.addEventListener('click', (event) => {
          event.stopPropagation();
          this.pause();
          this.setTime(this.timeFromEvent(event));
        });
        hit.addEventListener('dblclick', (event) => {
          event.stopPropagation();
          const time = this.timeFromEvent(event);
          this.setTime(time);
          this.addKeyframeForTrack(track, time);
        });
      });
      r.trackLabels.querySelectorAll('[data-track-add]').forEach((button) => {
        button.addEventListener('click', () => this.addKeyframeForTrack(button.dataset.trackAdd));
      });
      this.bindRuler();
    }

    r.trackLabels.querySelectorAll('.track-label-row').forEach((row) => {
      const track = row.querySelector('[data-track-add]')?.dataset.trackAdd;
      row.addEventListener('mouseenter', () => {
        const objectRow = track ? r.trackRows.querySelector(`.track-row[data-track="${track}"]`) : null;
        objectRow?.classList.add('hover');
      });
    });

    this.updateKeySelectionUI();
    this.syncSettingsControls();
    this.updatePlayheadDom();
  }

  renderRuler() {
    if (!this.refs.ruler || !this.project) return;
    const duration = this.project.settings.duration || 6;
    const width = Math.max(this.refs.timelineScroll.clientWidth || 640, this.refs.timelineInner.getBoundingClientRect().width || 640);
    const pxPerSecond = width / duration;
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
    const major = steps.find((step) => step * pxPerSecond >= 56) || 60;
    let html = '';
    let time = 0;
    while (time <= duration + 0.0001) {
      const pct = (time / duration) * 100;
      html += `<div class="ruler-tick" style="left:${pct}%"><span>${fmt(time, major < 1 ? 1 : 0).replace('.', ',')}s</span></div>`;
      const minor = time + major / 2;
      if (minor < duration - 0.0001) {
        html += `<div class="ruler-tick minor" style="left:${(minor / duration) * 100}%"></div>`;
      }
      time = roundTime(time + major);
    }
    this.refs.ruler.innerHTML = html;
  }

  bindRuler() {
    const ruler = this.refs.ruler;
    ruler.onpointerdown = (event) => {
      event.preventDefault();
      this.pause();
      this.setTime(this.timeFromEvent(event));
      ruler.setPointerCapture(event.pointerId);
      const move = (moveEvent) => this.setTime(this.timeFromEvent(moveEvent));
      const up = () => {
        ruler.removeEventListener('pointermove', move);
        ruler.removeEventListener('pointerup', up);
        ruler.removeEventListener('pointercancel', up);
      };
      ruler.addEventListener('pointermove', move);
      ruler.addEventListener('pointerup', up);
      ruler.addEventListener('pointercancel', up);
    };
  }

  timeFromEvent(event) {
    const rect = this.refs.timelineInner.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, 0, rect.width);
    return (x / Math.max(1, rect.width)) * (this.project.settings.duration || 6);
  }

  updatePlayheadDom(now = performance.now()) {
    if (!this.project || !this.refs.playhead) return;
    const duration = this.project.settings.duration || 6;
    const pct = clamp(this.time / duration, 0, 1) * 100;
    this.refs.playhead.style.left = `${pct}%`;
    this.refs.timeReadout.textContent = formatTimecode(this.time, this.project.settings.fps);
    if (this.recordingActive) {
      this.refs.recordTime.textContent = `${formatSeconds(this.time)} / ${formatSeconds(duration)}`;
    }
    if (this.engine && now - this.lastInspectorSync > 150) {
      this.lastInspectorSync = now;
      if (this.selectedId) this.syncTransformInputs();
    }
  }

  setTime(value, { snap = false } = {}) {
    if (!this.project) return;
    const duration = this.project.settings.duration || 6;
    let time = clamp(Number(value) || 0, 0, duration);
    if (snap) {
      const fps = this.project.settings.fps || 30;
      time = clamp(Math.round(time * fps) / fps, 0, duration);
    }
    this.time = time;
    this.engine?.applyTime(time);
    this.updatePlayheadDom();
    if (!this.playing) this.syncTransformInputs();
  }

  togglePlay() {
    if (this.playing) this.pause();
    else this.play();
  }

  play() {
    if (!this.project) return;
    if (this.time >= this.project.settings.duration - 1e-4) this.setTime(0);
    this.playing = true;
    this.updatePlayButton();
    this.setHint('Reproduzindo a linha do tempo · pressione Espaço para pausar');
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.updatePlayButton();
    this.setHint(this.selectedObject() ? `${this.selectedObject().name} selecionado` : 'Clique para selecionar · arraste para orbitar · scroll para zoom');
  }

  advance(dt) {
    const duration = this.project.settings.duration || 6;
    this.time += dt * this.speed;
    if (this.time >= duration - 1e-5) {
      if (this.recordingActive) {
        this.time = duration;
        this.engine.applyTime(duration);
        this.pause();
        this.scheduleRecordingEnd();
        return;
      }
      if (this.project.settings.loop !== false) {
        this.time %= duration;
      } else {
        this.time = duration;
        this.pause();
      }
    }
    this.engine.applyTime(this.time);
  }

  jumpTo(where) {
    this.pause();
    this.setTime(where === 'start' ? 0 : this.project.settings.duration, { snap: true });
  }

  stepFrame(direction) {
    this.pause();
    const fps = this.project.settings.fps || 30;
    const frame = Math.round(this.time * fps);
    this.setTime((frame + direction) / fps, { snap: true });
  }

  toggleLoop() {
    this.project.settings.loop = this.project.settings.loop === false;
    this.syncSettingsControls();
    this.pushHistory();
  }

  toggleAutoKey() {
    this.autoKey = !this.autoKey;
    this.refs.autokeyBtn.classList.toggle('active', this.autoKey);
    this.refs.autokeyBtn.setAttribute('aria-pressed', String(this.autoKey));
    this.toast(this.autoKey ? 'Auto-key ligado: transformações criam keyframes.' : 'Auto-key desligado.', this.autoKey ? 'success' : 'info', 2200);
  }

  selectKey(track, key, element) {
    this.selectedKey = { track, ref: key };
    if (element) {
      this.refs.trackRows.querySelectorAll('.key-diamond.selected').forEach((item) => item.classList.remove('selected'));
      element.classList.add('selected');
    }
    this.syncSettingsControls();
  }

  updateKeySelectionUI() {
    this.refs.trackRows.querySelectorAll('.key-diamond').forEach((item) => {
      const selected =
        this.selectedKey &&
        item.dataset.track === this.selectedKey.track &&
        Math.abs(Number(item.dataset.t) - this.selectedKey.ref.t) < 0.001;
      item.classList.toggle('selected', !!selected);
    });
    this.syncSettingsControls();
  }

  startKeyDrag(event, key, track, element) {
    event.preventDefault();
    event.stopPropagation();
    this.pause();
    this.selectKey(track, key, element);
    this.setTime(key.t);
    const row = this.refs.trackRows;
    const duration = this.project.settings.duration || 6;
    const startX = event.clientX;
    const startT = key.t;
    const width = Math.max(1, row.getBoundingClientRect().width);
    element.classList.add('dragging');
    element.setPointerCapture(event.pointerId);

    const move = (moveEvent) => {
      const delta = ((moveEvent.clientX - startX) / width) * duration;
      key.t = roundTime(clamp(startT + delta, 0, duration));
      sortKeys(this.selectedObject().keyframes[track]);
      element.dataset.t = String(key.t);
      element.style.left = `${(key.t / duration) * 100}%`;
      element.title = `${TRACK_META[track].label} · ${key.t.toFixed(2)}s · ${key.ease}`;
      this.setTime(key.t);
    };
    const up = () => {
      element.classList.remove('dragging');
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
      this.pushHistory();
      this.renderTimeline();
      this.refreshKeyCounts();
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
  }

  addKeyframeForTrack(track, time = this.time) {
    const object = this.selectedObject();
    if (!object) {
      this.toast('Selecione um objeto para criar keyframes.', 'info');
      return;
    }
    if (!tracksFor(object).includes(track)) return;
    const value = trackValue(object, track);
    const existing = object.keyframes[track].some((key) => Math.abs(key.t - roundTime(time)) < 0.001);
    const key = upsertKeyframe(object.keyframes[track], time, value, 'easeInOut');
    this.selectedKey = { track, ref: key };
    this.engine.applyTime(this.time);
    this.pushHistory();
    this.renderTimeline();
    this.refreshKeyCounts();
    this.toast(existing ? 'Keyframe atualizado.' : 'Keyframe criado.', 'success', 1800);
  }

  addAllKeys() {
    const object = this.selectedObject();
    if (!object) {
      this.toast('Selecione um objeto para criar keyframes.', 'info');
      return;
    }
    const tracks = tracksFor(object);
    let first = null;
    for (const track of tracks) {
      const key = upsertKeyframe(object.keyframes[track], this.time, trackValue(object, track), 'easeInOut');
      if (!first) first = { track, ref: key };
    }
    this.selectedKey = first;
    this.engine.applyTime(this.time);
    this.pushHistory();
    this.renderTimeline();
    this.refreshKeyCounts();
    this.toast(`Keyframes criados em ${formatTimecode(this.time, this.project.settings.fps)}.`, 'success', 2000);
  }

  setKeyEase(value) {
    if (!this.selectedKey?.ref) return;
    this.selectedKey.ref.ease = value;
    this.engine.applyTime(this.time);
    this.pushHistory();
    this.toast(`Ease: ${EASE_OPTIONS.find(([id]) => id === value)?.[1] || value}`, 'info', 1400);
  }

  deleteSelectedKey() {
    const object = this.selectedObject();
    if (!object || !this.selectedKey?.ref) return;
    const keys = object.keyframes?.[this.selectedKey.track];
    if (!keys) return;
    removeKeyframe(keys, this.selectedKey.ref);
    this.selectedKey = null;
    this.engine.applyTime(this.time);
    this.pushHistory();
    this.renderTimeline();
    this.refreshKeyCounts();
    this.toast('Keyframe removido.', 'info', 1600);
  }

  clearKeys() {
    const object = this.selectedObject();
    if (!object) return;
    object.keyframes = emptyKeyframes();
    this.selectedKey = null;
    this.engine.applyTime(this.time);
    this.pushHistory();
    this.renderTimeline();
    this.renderInspector();
    this.toast('Keyframes removidos do objeto.', 'info', 1800);
  }

  async addObject(kind) {
    if (!kind || !this.project) return;
    const selected = this.selectedObject();
    const parentId = selected?.kind === 'group' ? selected.id : null;
    let object = null;

    if (PRIMITIVE_DEFS.some((primitive) => primitive.id === kind)) {
      object = createPrimitive(kind, this.project);
      object.parentId = parentId;
      this.project.objects.push(object);
    } else if (kind === 'group') {
      object = createGroup(this.project, { parentId });
      this.project.objects.push(object);
    } else if (kind.startsWith('light-')) {
      const type = kind.replace('light-', '');
      object = createLight(type, this.project);
      this.project.objects.push(object);
    } else if (kind === 'camera') {
      const existing = this.project.objects.find((item) => item.kind === 'camera');
      if (existing) {
        this.select(existing.id);
        this.toast('A cena já tem uma câmera. Ela foi selecionada.', 'info');
        return;
      }
      object = createCamera(this.project);
      this.project.objects.push(object);
    }
    if (!object) return;
    this.selectedId = object.id;
    await this.rebuildScene();
    this.pushHistory();
    this.updateLiveButton();
    this.toast(`${TYPE_LABEL[object.kind]} "${object.name}" adicionado.`, 'success', 2000);
  }

  async deleteSelectedObject() {
    const object = this.selectedObject();
    if (!object) return;
    const ids = new Set(descendantIds(this.project, object.id));
    if (object.kind === 'camera' && this.live) this.setLiveCamera(false);
    const parentId = object.parentId;
    this.project.objects = this.project.objects.filter((item) => !ids.has(item.id));
    this.selectedId = parentId && this.project.objects.some((item) => item.id === parentId) ? parentId : null;
    this.selectedKey = null;
    await this.rebuildScene();
    this.pushHistory();
    this.updateLiveButton();
    this.toast('Objeto removido. Use Ctrl+Z para desfazer.', 'info', 2400);
  }

  async duplicateSelected() {
    const object = this.selectedObject();
    if (!object) return;
    if (object.kind === 'camera') {
      this.toast('A cena aceita apenas uma câmera.', 'info');
      return;
    }
    const clones = cloneObjectTree(this.project, object.id);
    if (!clones.length) return;
    this.selectedId = clones[0].id;
    await this.rebuildScene();
    this.pushHistory();
    this.toast(`"${object.name}" duplicado.`, 'success', 1800);
  }

  async rebuildScene() {
    if (!this.project || !this.engine) return;
    const selectedId = this.project.objects.some((item) => item.id === this.selectedId) ? this.selectedId : null;
    await this.engine.build(this.project, { selectedId, time: this.time });
    this.selectedId = selectedId;
    this.engine.setSelection(selectedId);
    this.engine.applyTime(this.time);
    this.renderAll();
    this.updateLiveButton();
  }

  applyPresetSelected(presetId) {
    const object = this.selectedObject();
    if (!object) {
      this.toast('Selecione um objeto antes de aplicar uma animação.', 'info');
      return;
    }
    if (object.kind === 'camera' && (presetId === 'spin' || presetId === 'swing')) {
      this.toast('Esse preset gira o objeto e não funciona bem na câmera. Use flutuar, orbitar ou entrada.', 'info', 4000);
      return;
    }
    applyPresetToObject(object, presetId, this.project.settings.duration);
    this.selectedKey = null;
    this.engine.applyTime(this.time);
    this.pushHistory();
    this.renderTimeline();
    this.renderInspector();
    const preset = PRESET_DEFS.find((item) => item.id === presetId);
    this.toast(`Animação "${preset?.label || presetId}" aplicada em ${object.name}.`, 'success', 2200);
  }

  focusSelected() {
    const object = this.selectedObject();
    if (this.live) this.setLiveCamera(false);
    if (object) {
      this.engine.focusObject(object.id);
      this.setHint(`Enquadrando ${object.name}`);
    } else {
      this.engine.applyEditorCamera(this.project.camera, false);
      this.setHint('Câmera do editor resetada');
    }
  }

  setView(name, sourceButton = null) {
    if (!this.engine) return;
    if (this.live) this.setLiveCamera(false);
    this.engine.setView(name);
    const labels = { persp: 'Perspectiva', front: 'Frente', top: 'Topo', side: 'Lado' };
    document.querySelectorAll('.view-btn[data-view]').forEach((button) => {
      button.classList.toggle('active', button.dataset.view === name);
    });
    if (sourceButton) {
      document.querySelectorAll('.inline-btn[data-view]').forEach((button) => {
        button.classList.toggle('active', button === sourceButton);
      });
    }
    this.setHint(`Vista ${labels[name] || name} · arraste para orbitar`);
  }

  setLiveCamera(enabled) {
    if (!this.engine) return;
    const hasCamera = this.project.objects.some((object) => object.kind === 'camera');
    if (enabled && !hasCamera) {
      this.toast('Adicione uma câmera à cena para usar essa vista.', 'info');
      return;
    }
    this.live = !!enabled;
    this.engine.setLiveCamera(enabled);
    this.updateLiveButton();
    this.setHint(
      enabled
        ? 'Vista da câmera · o viewport mostra o enquadramento final'
        : 'Clique para selecionar · arraste para orbitar · scroll para zoom',
    );
  }

  setTransformMode(mode) {
    if (!this.engine) return;
    this.engine.transform.setMode(mode);
    [this.refs.modeTranslate, this.refs.modeRotate, this.refs.modeScale].forEach((button) => {
      button.classList.toggle('active', button.dataset.mode === mode);
    });
  }

  toggleSpace() {
    if (!this.engine) return;
    const space = this.engine.transform.space === 'local' ? 'world' : 'local';
    this.engine.transform.setSpace(space);
    this.refs.spaceLabel.textContent = space === 'local' ? 'Local' : 'Mundo';
  }

  resetHistory() {
    if (!this.project) return;
    this.history = [JSON.stringify(this.project)];
    this.historyIndex = 0;
    this.updateHistoryButtons();
  }

  pushHistory() {
    if (!this.project || this.restoring) return;
    this.queueSave();
    const snapshot = JSON.stringify(this.project);
    if (this.history[this.historyIndex] === snapshot) return;
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(snapshot);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.historyIndex = this.history.length - 1;
    this.updateHistoryButtons();
  }

  queueSave() {
    this.setSaveState('Salvando…', 'is-dirty');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persist(), 420);
  }

  persist() {
    if (!this.project) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.project));
      this.setSaveState('Salvo localmente');
    } catch (error) {
      console.warn('Falha ao salvar localmente', error);
      this.setSaveState('Não foi possível salvar', 'is-error');
      if (!this.storageWarned) {
        this.storageWarned = true;
        this.toast('O projeto é grande demais para o salvamento automático. Use "Salvar" para baixar uma cópia.', 'error', 6500);
      }
    }
  }

  async undo() {
    if (this.restoring || this.historyIndex <= 0) return;
    this.restoring = true;
    this.historyIndex -= 1;
    await this.restoreSnapshot(this.history[this.historyIndex]);
    this.restoring = false;
    this.updateHistoryButtons();
  }

  async redo() {
    if (this.restoring || this.historyIndex >= this.history.length - 1) return;
    this.restoring = true;
    this.historyIndex += 1;
    await this.restoreSnapshot(this.history[this.historyIndex]);
    this.restoring = false;
    this.updateHistoryButtons();
  }

  async restoreSnapshot(snapshot) {
    if (!snapshot || !this.engine) return;
    const token = ++this.restoreToken;
    let project;
    try {
      project = normalizeProject(JSON.parse(snapshot));
    } catch (error) {
      this.toast('Não foi possível restaurar este estado.', 'error');
      return;
    }
    if (token !== this.restoreToken) return;
    this.project = project;
    if (this.selectedId && !project.objects.some((object) => object.id === this.selectedId)) {
      this.selectedId = defaultSelection(project)?.id || null;
    }
    this.time = clamp(this.time, 0, project.settings.duration);
    const selected = this.selectedId;
    await this.engine.build(project, { selectedId: selected, time: this.time });
    if (token !== this.restoreToken) return;
    this.engine.setSelection(selected);
    if (this.live) this.engine.setLiveCamera(true);
    this.renderAll();
    this.queueSave();
  }

  saveProject() {
    if (!this.project) return;
    this.persist();
    const data = JSON.stringify(this.project, null, 2);
    downloadBlob(new Blob([data], { type: 'application/json' }), `${slugify(this.project.name)}.json`);
    this.setSaveState('Salvo localmente');
    this.toast('Projeto baixado em .json.', 'success', 2200);
  }

  async openProjectFile(file) {
    try {
      if (file.size > 60 * 1024 * 1024) throw new Error('Arquivo muito grande.');
      const text = await file.text();
      const project = normalizeProject(JSON.parse(text));
      if (this.recordingActive) this.finishRecording();
      this.pause();
      this.live = false;
      this.engine.setLiveCamera(false);
      this.project = project;
      this.selectedId = defaultSelection(project)?.id || null;
      this.selectedKey = null;
      this.time = 0;
      this.zoom = 1;
      await this.engine.build(project, { selectedId: this.selectedId, time: 0 });
      this.engine.applyEditorCamera(project.camera, true);
      this.engine.setSelection(this.selectedId);
      this.resetHistory();
      this.renderAll();
      this.updateLiveButton();
      this.persist();
      this.closeDrawers();
      this.toast(`Projeto "${project.name}" aberto.`, 'success', 2400);
    } catch (error) {
      console.error(error);
      this.toast('Não foi possível abrir esse projeto. Verifique o arquivo .json.', 'error', 6000);
    }
  }

  async importModel(file) {
    const name = file.name || 'modelo';
    const ext = name.split('.').pop()?.toLowerCase();
    if (!['glb', 'gltf'].includes(ext)) {
      this.toast('Use um arquivo .glb ou .gltf.', 'error', 4000);
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      this.toast('O modelo passa de 25 MB. Use uma versão mais leve.', 'error', 5000);
      return;
    }
    this.setHint(`Importando ${name}…`);
    try {
      const buffer = await file.arrayBuffer();
      const info = await this.engine.parseModel(buffer);
      const base64 = bufferToBase64(buffer);
      const label = name.replace(/\.(glb|gltf)$/i, '');
      const object = {
        id: uid('imp'),
        name: uniqueName(this.project.objects, label || 'Modelo'),
        kind: 'imported',
        parentId: null,
        visible: true,
        castShadow: true,
        receiveShadow: true,
        transform: createTransform([0, 0, 0]),
        keyframes: emptyKeyframes(),
        geometry: null,
        material: null,
        light: null,
        clip: info.animations.length ? { index: 0, enabled: true, speed: 1, loop: true } : null,
        asset: {
          id: info.assetId,
          name,
          data: base64,
          animations: info.animations,
        },
      };
      this.project.objects.push(object);
      this.selectedId = object.id;
      this.selectedKey = null;
      this.time = 0;
      await this.rebuildScene();
      this.engine.applyTime(0);
      this.engine.focusObject(object.id);
      this.pushHistory();
      this.setHint('Clique para selecionar · arraste para orbitar · scroll para zoom');
      this.toast(
        info.animations.length
          ? `"${name}" importado com ${info.animations.length} animação(ões).`
          : `"${name}" importado. Anime-o pela linha do tempo.`,
        'success',
        3600,
      );
    } catch (error) {
      console.error(error);
      this.setHint('Clique para selecionar · arraste para orbitar · scroll para zoom');
      this.toast('Falha ao importar. Prefira .glb com texturas embutidas.', 'error', 6500);
    }
  }

  handleExport(type) {
    if (type === 'json') this.saveProject();
    else if (type === 'glb') this.exportGLB();
    else if (type === 'png') this.exportPNG();
    else if (type === 'video') this.startRecording();
  }

  async exportGLB() {
    if (this.busy) return;
    this.busy = true;
    this.pause();
    this.toast('Preparando .glb com animações e câmera…', 'info', 2600);
    try {
      const result = await this.engine.exportGLB();
      const blob = new Blob([result], { type: 'model/gltf-binary' });
      downloadBlob(blob, `${slugify(this.project.name)}.glb`);
      this.toast('Modelo .glb exportado.', 'success', 2600);
    } catch (error) {
      console.error(error);
      this.toast('Não foi possível exportar o GLB.', 'error', 5000);
    } finally {
      this.busy = false;
      this.engine.render();
    }
  }

  exportPNG() {
    this.pause();
    this.engine.applyTime(this.time);
    if (this.live) this.engine.setLiveCamera(true);
    this.engine.render();
    this.engine.renderer.domElement.toBlob((blob) => {
      if (!blob) {
        this.toast('Não foi possível capturar a imagem.', 'error');
        return;
      }
      downloadBlob(blob, `${slugify(this.project.name)}-${Date.now()}.png`);
      this.toast('Imagem PNG exportada.', 'success', 2200);
    }, 'image/png');
  }

  startRecording() {
    if (this.recordingActive) return;
    const canvas = this.engine?.renderer.domElement;
    if (!canvas || typeof canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') {
      this.toast('Este navegador não suporta gravação de vídeo. Exporte PNG ou GLB.', 'error', 5500);
      return;
    }
    const picked = pickRecordingMime();
    if (!picked) {
      this.toast('Este navegador não suporta gravação de vídeo.', 'error', 5000);
      return;
    }
    const fps = Math.max(24, this.project.settings.fps || 30);
    let stream;
    try {
      stream = canvas.captureStream(fps);
    } catch (error) {
      console.error(error);
      this.toast('Não foi possível capturar o viewport.', 'error');
      return;
    }
    let recorder;
    try {
      recorder = picked.mime
        ? new MediaRecorder(stream, { mimeType: picked.mime, videoBitsPerSecond: 12_000_000 })
        : new MediaRecorder(stream);
    } catch (error) {
      try {
        recorder = new MediaRecorder(stream);
      } catch (fallbackError) {
        console.error(fallbackError);
        this.toast('Não foi possível iniciar a gravação.', 'error');
        return;
      }
    }
    const chunks = [];
    this.recording = { recorder, chunks, mime: picked.mime, ext: picked.ext, finishing: false };
    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };
    recorder.onstop = () => this.handleRecordingStop();
    this.recordingActive = true;
    this.pause();
    this.time = 0;
    this.engine.applyTime(0);
    this.playing = true;
    this.updatePlayButton();
    this.refs.recordHud.hidden = false;
    this.refs.recordTime.textContent = `${formatSeconds(0)} / ${formatSeconds(this.project.settings.duration)}`;
    this.setHint('Gravando um ciclo do viewport…');
    recorder.start(120);
    this.toast('Gravando o viewport. Ative a câmera ao vivo para gravar o enquadramento final.', 'info', 4200);
  }

  scheduleRecordingEnd() {
    if (this.recordFinishTimer) return;
    this.recordFinishTimer = setTimeout(() => {
      this.recordFinishTimer = null;
      this.finishRecording();
    }, 320);
  }

  finishRecording() {
    if (!this.recording || this.recording.finishing) return;
    this.recording.finishing = true;
    this.recordingActive = false;
    this.playing = false;
    this.updatePlayButton();
    this.refs.recordHud.hidden = true;
    this.setHint('Clique para selecionar · arraste para orbitar · scroll para zoom');
    try {
      this.recording.recorder.stop();
    } catch (error) {
      console.error(error);
      this.recording = null;
      this.toast('A gravação foi encerrada sem arquivo.', 'error');
    }
  }

  handleRecordingStop() {
    const recording = this.recording;
    if (!recording) return;
    this.recording = null;
    const blob = new Blob(recording.chunks, { type: recording.recorder.mimeType || recording.mime || 'video/webm' });
    if (!blob.size) {
      this.toast('A gravação ficou vazia. Tente novamente.', 'error', 4500);
      return;
    }
    const ext = (recording.recorder.mimeType || '').includes('mp4') ? 'mp4' : recording.ext || 'webm';
    downloadBlob(blob, `${slugify(this.project.name)}-${Date.now()}.${ext}`);
    this.toast('Vídeo exportado do viewport.', 'success', 3000);
  }

  async newProject(templateId) {
    this.pause();
    if (this.recordingActive) this.finishRecording();
    if (this.live) this.setLiveCamera(false);
    const project = createTemplate(templateId);
    this.project = project;
    this.selectedId = defaultSelection(project)?.id || null;
    this.selectedKey = null;
    this.time = 0;
    this.zoom = 1;
    this.speed = 1;
    this.autoKey = false;
    this.search = '';
    this.refs.objectSearch.value = '';
    this.engine.setLiveCamera(false);
    await this.engine.build(project, { selectedId: this.selectedId, time: 0 });
    this.engine.applyEditorCamera(project.camera, true);
    this.engine.setSelection(this.selectedId);
    this.resetHistory();
    this.renderAll();
    this.updateLiveButton();
    this.persist();
    this.closeDrawers();
    this.setHint('Clique para selecionar · arraste para orbitar · scroll para zoom');
    this.toast(`Cena "${project.name}" criada.`, 'success', 2400);
  }

  openTemplates() {
    const modal = this.openModal(`
      <div class="modal-head">
        <div>
          <h2 id="modalTitle">Novo projeto</h2>
          <p>Escolha um ponto de partida. A cena atual será substituída — baixe uma cópia antes se precisar guardá-la.</p>
        </div>
        <button class="modal-close" data-modal-close aria-label="Fechar">${icon('close', 15)}</button>
      </div>
      <div class="template-grid">
        <button class="template-card" data-template="empty">
          <span class="template-thumb empty"></span>
          <span class="template-meta"><strong>Cena vazia</strong><small>Só câmera e luzes, pronta para começar do zero.</small></span>
        </button>
        <button class="template-card" data-template="neon">
          <span class="template-thumb neon"></span>
          <span class="template-meta"><strong>Órbita neon</strong><small>Objetos metálicos, satélites e animação em loop.</small></span>
        </button>
        <button class="template-card" data-template="showcase">
          <span class="template-thumb showcase"></span>
          <span class="template-meta"><strong>Vitrine</strong><small>Produto em pedestal, turntable e câmera em movimento.</small></span>
        </button>
      </div>
      <div class="about-line">Dica: você também pode importar modelos GLB e animá-los com as ferramentas do estúdio.</div>
    `);
    modal.querySelectorAll('[data-template]').forEach((button) => {
      button.addEventListener('click', () => {
        this.closeModal();
        this.newProject(button.dataset.template);
      });
    });
  }

  showHelp() {
    this.openModal(`
      <div class="modal-head">
        <div>
          <h2 id="modalTitle">Como usar o Prisma 3D</h2>
          <p>Um estúdio completo no navegador: crie, anime, ilumine e exporte.</p>
        </div>
        <button class="modal-close" data-modal-close aria-label="Fechar">${icon('close', 15)}</button>
      </div>
      <div class="help-grid">
        <div class="help-block">
          <h3>Fluxo rápido</h3>
          <p>1. Selecione um objeto na cena.<br />
          2. Arraste o gizmo (W, E, R) e pressione <kbd>K</kbd> para gravar um keyframe.<br />
          3. Posicione o playhead e crie novos keyframes.<br />
          4. Reproduza com <kbd>Espaço</kbd> e ajuste a suavização.<br />
          5. Exporte vídeo, PNG ou um GLB animado.</p>
        </div>
        <div class="help-block">
          <h3>Linha do tempo</h3>
          <p>Clique na régua para navegar. Duplo clique numa faixa cria um keyframe naquele instante. Arraste os losangos para mover keyframes e use o seletor <strong>Suavização</strong> para ajustar o movimento. O botão <strong>Auto-key</strong> grava transformações automaticamente.</p>
        </div>
        <div class="help-block">
          <h3>Câmera e exportação</h3>
          <p>Selecione a câmera para animar posição e alvo. O botão <strong>Câmera</strong> no viewport mostra o enquadramento final. Vídeos gravam um ciclo do viewport; GLB inclui malhas, materiais, luzes, câmera e animações.</p>
        </div>
        <div class="help-block">
          <h3>Atalhos</h3>
          <div class="shortcut-list">
            <div><span>Mover / Girar / Escalar</span><span><kbd>W</kbd> <kbd>E</kbd> <kbd>R</kbd></span></div>
            <div><span>Reproduzir / Pausar</span><kbd>Espaço</kbd></div>
            <div><span>Criar keyframe</span><kbd>K</kbd></div>
            <div><span>Enquadrar seleção</span><kbd>F</kbd></div>
            <div><span>Desfazer / Refazer</span><span><kbd>Ctrl</kbd>+<kbd>Z</kbd> <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd></span></div>
            <div><span>Salvar / Abrir</span><span><kbd>Ctrl</kbd>+<kbd>S</kbd> <kbd>Ctrl</kbd>+<kbd>O</kbd></span></div>
            <div><span>Duplicar / Excluir</span><span><kbd>Ctrl</kbd>+<kbd>D</kbd> <kbd>Del</kbd></span></div>
            <div><span>Grade / Câmera ao vivo</span><span><kbd>G</kbd> <kbd>L</kbd></span></div>
          </div>
        </div>
      </div>
      <div class="about-line">Prisma 3D · projeto salvo automaticamente neste navegador · exportações sempre disponíveis pelo menu.</div>
    `);
  }

  openModal(html) {
    this.pause();
    this.modalOpen = true;
    this.refs.modalRoot.innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">${html}</div></div>`;
    const modal = this.refs.modalRoot.querySelector('.modal');
    setTimeout(() => {
      const focusable = modal?.querySelector('button, input, select');
      focusable?.focus();
    }, 40);
    return modal;
  }

  closeModal() {
    this.modalOpen = false;
    if (this.refs.modalRoot) this.refs.modalRoot.innerHTML = '';
  }

  toast(message, type = 'info', duration = 3400) {
    if (!this.refs.toasts) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const ico = type === 'success' ? 'check' : type === 'error' ? 'info' : 'info';
    el.innerHTML = `${icon(ico, 14)}<span>${esc(message)}</span>`;
    this.refs.toasts.appendChild(el);
    while (this.refs.toasts.children.length > 4) this.refs.toasts.firstElementChild.remove();
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 280);
    }, duration);
  }

  handleKeyboard(event) {
    if (event.key === 'Escape') {
      if (this.modalOpen) {
        this.closeModal();
        return;
      }
      this.toggleExportMenu(false);
      this.refs.addMenu.hidden = true;
      this.refs.addBtn.classList.remove('open');
      this.closeDrawers();
      if (this.selectedKey) {
        this.selectedKey = null;
        this.updateKeySelectionUI();
      }
      return;
    }
    if (this.modalOpen) return;
    const typing = isTypingTarget(event.target);
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !typing) {
      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (key === 'y') {
        event.preventDefault();
        this.redo();
        return;
      }
      if (key === 's') {
        event.preventDefault();
        this.saveProject();
        return;
      }
      if (key === 'o') {
        event.preventDefault();
        this.refs.projectFileInput.click();
        return;
      }
      if (key === 'n') {
        event.preventDefault();
        this.openTemplates();
        return;
      }
      if (key === 'd') {
        event.preventDefault();
        this.duplicateSelected();
        return;
      }
    }
    if (typing) return;
    if (event.key === ' ' && (document.activeElement?.tagName === 'BUTTON' || document.activeElement?.tagName === 'A')) return;
    if (event.key === ' ') {
      event.preventDefault();
      this.togglePlay();
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'w' || key === 'e' || key === 'r') {
      const mode = key === 'w' ? 'translate' : key === 'e' ? 'rotate' : 'scale';
      this.setTransformMode(mode);
      return;
    }
    if (key === 'f') {
      event.preventDefault();
      this.focusSelected();
      return;
    }
    if (key === 'k') {
      event.preventDefault();
      this.addAllKeys();
      return;
    }
    if (key === 'g') {
      this.toggleSetting('grid');
      return;
    }
    if (key === 'l') {
      this.setLiveCamera(!this.live);
      return;
    }
    if (event.key === '?' || (event.shiftKey && key === '/')) {
      event.preventDefault();
      this.showHelp();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      if (this.selectedKey) this.deleteSelectedKey();
      else this.deleteSelectedObject();
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      const count = event.shiftKey ? 10 : 1;
      this.pause();
      const fps = this.project.settings.fps || 30;
      const frame = Math.round(this.time * fps);
      this.setTime((frame + direction * count) / fps, { snap: true });
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      this.jumpTo('start');
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      this.jumpTo('end');
    }
  }

}

export { normalizeProject, defaultSelection, nodeColor, tracksFor, trackValue, totalKeys };
