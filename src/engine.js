import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { clamp, sampleTrack, uid } from './model.js';

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();
const _world = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _target = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _mat = new THREE.Matrix4();

function geometryFor(type) {
  switch (type) {
    case 'sphere':
      return new THREE.SphereGeometry(0.75, 64, 48);
    case 'cylinder':
      return new THREE.CylinderGeometry(0.5, 0.5, 1, 64, 1, false);
    case 'cone':
      return new THREE.ConeGeometry(0.6, 1.4, 64);
    case 'torus':
      return new THREE.TorusGeometry(1, 0.055, 24, 128);
    case 'plane':
      return new THREE.PlaneGeometry(2, 2);
    case 'box':
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
}

function base64ToArrayBuffer(base64) {
  const clean = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

export class Engine {
  constructor(container, callbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;
    this.project = null;
    this.runtime = new Map();
    this.assetCache = new Map();
    this.selectedId = null;
    this.liveCamera = false;
    this.dragging = false;
    this.lastTransformEnd = 0;
    this.currentTime = 0;
    this.buildToken = 0;
    this.tween = null;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#060913');
    this.scene.fog = new THREE.FogExp2('#060913', 0.022);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.className = 'scene-canvas';
    this.renderer.domElement.setAttribute('aria-label', 'Viewport 3D da cena');
    this.container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
    this.camera.position.set(7.2, 4.8, 9.8);
    this.shotCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
    this.shotCamera.position.set(6.6, 4.4, 9.2);
    this.shotCamera.lookAt(0, 1.2, 0);
    this.shotCamera.name = 'Câmera';

    this.helpers = new THREE.Group();
    this.helpers.name = 'Ajudantes do editor';
    this.content = new THREE.Group();
    this.content.name = 'Cena';
    this.scene.add(this.helpers, this.content);

    this.buildEnvironment();
    this.buildGround();
    this.buildSelection();

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.075;
    this.orbit.minDistance = 1.4;
    this.orbit.maxDistance = 90;
    this.orbit.maxPolarAngle = Math.PI / 2 - 0.012;
    this.orbit.target.set(0, 1.3, 0);
    this.orbit.addEventListener('start', () => {
      this.tween = null;
      this.callbacks.onOrbitStart?.();
    });

    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.setSize(0.92);
    this.transform.setSpace('world');
    this.transform.addEventListener('dragging-changed', (event) => {
      this.dragging = event.value;
      this.orbit.enabled = !event.value && !this.liveCamera;
      if (event.value) this.transformActive = true;
      if (!event.value) {
        this.lastTransformEnd = performance.now();
        this.transformActive = false;
        this.callbacks.onTransformCommit?.();
      }
    });
    this.transform.addEventListener('objectChange', () => {
      this.callbacks.onTransform?.();
    });
    this.scene.add(this.transform.getHelper());

    this.loader = new GLTFLoader();

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pointerDown = null;
    this.bindPointer();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
  }

  buildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const environment = new RoomEnvironment();
    this.environmentMap = pmrem.fromScene(environment, 0.04).texture;
    environment.dispose?.();
    pmrem.dispose();
    this.scene.environment = this.environmentMap;
    this.scene.environmentIntensity = 0.55;

    const hemi = new THREE.HemisphereLight(0x8fb4ff, 0x05070d, 0.32);
    this.helpers.add(hemi);

    const count = 260;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const r = 4 + Math.random() * 17;
      const a = Math.random() * Math.PI * 2;
      positions[i * 3] = Math.cos(a) * r;
      positions[i * 3 + 1] = 0.3 + Math.random() * 9;
      positions[i * 3 + 2] = Math.sin(a) * r;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const dustMat = new THREE.PointsMaterial({
      color: 0x7dd3fc,
      size: 0.032,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.dust = new THREE.Points(dustGeo, dustMat);
    this.dust.frustumCulled = false;
    this.helpers.add(this.dust);
  }

  buildGround() {
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x070b13,
      roughness: 0.9,
      metalness: 0.16,
      envMapIntensity: 0.7,
    });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.012;
    this.ground.receiveShadow = true;
    this.ground.name = 'Chão';
    this.helpers.add(this.ground);

    this.grid = new THREE.GridHelper(48, 96, 0x2c4266, 0x111c30);
    this.grid.position.y = 0.002;
    if (Array.isArray(this.grid.material)) {
      this.grid.material.forEach((m) => {
        m.transparent = true;
        m.opacity = 0.55;
        m.depthWrite = false;
      });
    } else {
      this.grid.material.transparent = true;
      this.grid.material.opacity = 0.55;
      this.grid.material.depthWrite = false;
    }
    this.helpers.add(this.grid);
  }

  buildSelection() {
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    const mat = new THREE.LineBasicMaterial({
      color: 0x67e8f9,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    this.selection = new THREE.LineSegments(geo, mat);
    this.selection.renderOrder = 999;
    this.selection.visible = false;
    this.selection.frustumCulled = false;
    this.helpers.add(this.selection);
  }

  bindPointer() {
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.pointerDown = { x: event.clientX, y: event.clientY, t: performance.now() };
    });
    canvas.addEventListener('pointerup', (event) => {
      if (event.button !== 0 || !this.pointerDown) return;
      const dist = Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y);
      const elapsed = performance.now() - this.pointerDown.t;
      const skip = performance.now() - this.lastTransformEnd < 180;
      this.pointerDown = null;
      if (dist > 6 || elapsed > 800 || skip || this.transformActive) return;
      const id = this.pick(event.clientX, event.clientY);
      this.callbacks.onSelect?.(id);
    });
    canvas.addEventListener('dblclick', (event) => {
      const id = this.pick(event.clientX, event.clientY);
      if (id) this.focusObject(id);
    });
  }

  pick(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.getCamera());
    const hits = this.raycaster.intersectObjects(this.content.children, true);
    for (const hit of hits) {
      let node = hit.object;
      while (node) {
        if (node.userData?.objectId) return node.userData.objectId;
        node = node.parent;
      }
    }
    return null;
  }

  async parseModel(buffer) {
    const gltf = await this.loader.parseAsync(buffer, '');
    const id = uid('asset');
    this.assetCache.set(id, Promise.resolve({ scene: gltf.scene, animations: gltf.animations }));
    return {
      assetId: id,
      animations: gltf.animations.map((clip, index) => ({
        name: clip.name || `Clipe ${index + 1}`,
        duration: clip.duration,
      })),
      objectName: gltf.scene?.name || '',
    };
  }

  async loadAsset(asset) {
    if (!asset) throw new Error('Modelo sem dados');
    if (this.assetCache.has(asset.id)) return this.assetCache.get(asset.id);
    const promise = (async () => {
      const buffer = base64ToArrayBuffer(asset.data);
      const gltf = await this.loader.parseAsync(buffer, '');
      return { scene: gltf.scene, animations: gltf.animations };
    })();
    this.assetCache.set(asset.id, promise);
    return promise;
  }

  disposeContent() {
    this.content.traverse((node) => {
      if (!node.isMesh) return;
      if (node.userData.sharedAsset) return;
      node.geometry?.dispose();
      if (Array.isArray(node.material)) node.material.forEach((m) => m.dispose());
      else node.material?.dispose();
    });
  }

  async build(project, { selectedId = null, time = 0 } = {}) {
    this.project = project;
    this.buildToken += 1;
    const token = this.buildToken;
    this.transform.detach();
    this.runtime.clear();
    this.disposeContent();
    this.content.clear();
    this.content.add(this.shotCamera);
    this.shotCamera.userData.objectId = '';

    const models = project.objects || [];
    const cameraModel = models.find((m) => m.kind === 'camera');
    if (cameraModel) {
      this.shotCamera.userData.objectId = cameraModel.id;
      this.shotCamera.name = cameraModel.name;
    }

    for (const model of models) {
      if (model.kind === 'camera') {
        this.runtime.set(model.id, {
          model,
          object3d: this.shotCamera,
          kind: 'camera',
          mixer: null,
          clips: [],
          activeAction: null,
        });
        continue;
      }
      if (model.kind === 'imported') {
        const root = new THREE.Group();
        root.name = model.name;
        root.userData.objectId = model.id;
        this.runtime.set(model.id, {
          model,
          object3d: root,
          kind: 'imported',
          mixer: null,
          clips: [],
          activeAction: null,
          animationRoot: null,
        });
        continue;
      }
      if (model.kind === 'light') {
        const light = this.createLight(model);
        light.userData.objectId = model.id;
        light.name = model.name;
        this.runtime.set(model.id, { model, object3d: light, kind: 'light' });
        continue;
      }
      if (model.kind === 'group') {
        const group = new THREE.Group();
        group.userData.objectId = model.id;
        group.name = model.name;
        this.runtime.set(model.id, { model, object3d: group, kind: 'group' });
        continue;
      }
      const geometry = geometryFor(model.geometry?.type || 'box');
      const material = this.createMaterial(model.material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.objectId = model.id;
      mesh.name = model.name;
      mesh.castShadow = model.castShadow !== false;
      mesh.receiveShadow = model.receiveShadow !== false;
      this.runtime.set(model.id, { model, object3d: mesh, kind: 'mesh' });
    }

    for (const model of models) {
      if (model.kind === 'camera') continue;
      const entry = this.runtime.get(model.id);
      if (!entry) continue;
      const parent = model.parentId ? this.runtime.get(model.parentId)?.object3d : null;
      (parent || this.content).add(entry.object3d);
      this.applyObjectState(model);
    }

    const clipPromises = [];
    for (const model of models) {
      if (model.kind !== 'imported' || !model.asset) continue;
      const entry = this.runtime.get(model.id);
      clipPromises.push(this.loadImported(entry, model, token));
    }
    await Promise.all(clipPromises);
    if (token !== this.buildToken) return;

    if (!this.initialized) {
      this.applyEditorCamera(project.camera, true);
      this.initialized = true;
    }
    this.applySettings(project.settings);
    this.currentTime = time;
    this.applyTime(time);
    this.setSelection(selectedId);
    this.resize();
  }

  createMaterial(source = {}) {
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(source.color || '#8b5cf6'),
      metalness: source.metalness ?? 0.35,
      roughness: source.roughness ?? 0.3,
      emissive: new THREE.Color(source.emissive || '#000000'),
      emissiveIntensity: source.emissiveIntensity ?? 0,
      transparent: (source.opacity ?? 1) < 1,
      opacity: source.opacity ?? 1,
      wireframe: !!source.wireframe,
      flatShading: !!source.flatShading,
      envMapIntensity: 0.95,
    });
    material.name = 'Material';
    return material;
  }

  createLight(model) {
    const data = model.light || {};
    let light;
    if (data.type === 'directional') {
      light = new THREE.DirectionalLight(new THREE.Color(data.color || '#ffffff'), data.intensity ?? 3);
      light.castShadow = model.castShadow !== false;
      light.shadow.mapSize.set(2048, 2048);
      light.shadow.camera.left = -12;
      light.shadow.camera.right = 12;
      light.shadow.camera.top = 12;
      light.shadow.camera.bottom = -12;
      light.shadow.camera.near = 0.5;
      light.shadow.camera.far = 45;
      light.shadow.bias = -0.0004;
      light.shadow.normalBias = 0.02;
      light.shadow.camera.updateProjectionMatrix();
    } else if (data.type === 'spot') {
      light = new THREE.SpotLight(
        new THREE.Color(data.color || '#ffffff'),
        data.intensity ?? 80,
        data.distance ?? 30,
        data.angle ?? Math.PI / 6,
        data.penumbra ?? 0.5,
        2,
      );
      light.castShadow = model.castShadow !== false;
      light.shadow.mapSize.set(1024, 1024);
      light.shadow.bias = -0.0003;
      light.shadow.normalBias = 0.02;
    } else {
      light = new THREE.PointLight(
        new THREE.Color(data.color || '#ffffff'),
        data.intensity ?? 40,
        data.distance ?? 0,
        2,
      );
    }
    light.position.fromArray(model.transform.position);
    if (light.target) this.content.add(light.target);
    return light;
  }

  async loadImported(entry, model, token) {
    if (!entry) return;
    try {
      const template = await this.loadAsset(model.asset);
      if (token !== this.buildToken) return;
      const inner = cloneSkeleton(template.scene);
      inner.updateMatrixWorld(true);
      _box.setFromObject(inner);
      if (!_box.isEmpty()) {
        _box.getSize(_size);
        _box.getCenter(_center);
        const maxDim = Math.max(_size.x, _size.y, _size.z) || 1;
        const scale = 2.2 / maxDim;
        inner.scale.setScalar(scale);
        inner.position.set(-_center.x * scale, -_box.min.y * scale, -_center.z * scale);
      }
      inner.traverse((node) => {
        if (node.isMesh) {
          node.castShadow = true;
          node.receiveShadow = true;
          node.userData.sharedAsset = true;
          if (node.material) {
            if (Array.isArray(node.material)) {
              node.material.forEach((m) => {
                m.envMapIntensity = 0.9;
              });
            } else {
              node.material.envMapIntensity = 0.9;
            }
          }
        }
      });
      const root = entry.object3d;
      root.add(inner);
      entry.inner = inner;
      entry.animationRoot = inner;
      entry.clips = template.animations || [];
      if (entry.clips.length > 0) {
        entry.mixer = new THREE.AnimationMixer(inner);
        this.configureClip(entry, model);
      }
      this.applyObjectState(model);
      this.applyTime(this.currentTime);
    } catch (error) {
      console.error('Falha ao carregar modelo importado', error);
      entry.failed = true;
      this.callbacks.onAssetError?.(model, error);
    }
  }

  configureClip(entry, model) {
    if (!entry?.mixer) return;
    entry.mixer.stopAllAction();
    entry.activeAction = null;
    if (!model.clip || model.clip.enabled === false) return;
    if (!entry.clips.length) return;
    const index = clamp(model.clip.index || 0, 0, entry.clips.length - 1);
    const clip = entry.clips[index];
    if (!clip) return;
    const action = entry.mixer.clipAction(clip);
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.enabled = true;
    action.play();
    entry.activeAction = action;
    entry.mixer.setTime(0);
  }

  applyObjectState(model) {
    const entry = this.runtime.get(model.id);
    if (!entry) return;
    const object = entry.object3d;
    object.name = model.name;
    object.visible = model.visible !== false;
    if (model.kind === 'camera') {
      object.position.fromArray(model.transform.position);
      object.fov = model.fov || 45;
      object.updateProjectionMatrix();
      this.lookAtCamera(model.target || [0, 1.2, 0]);
      return;
    }
    object.position.fromArray(model.transform.position);
    object.rotation.set(...model.transform.rotation.map(Number));
    object.scale.fromArray(model.transform.scale);
    if (model.kind === 'mesh' && object.isMesh) {
      object.castShadow = model.castShadow !== false;
      object.receiveShadow = model.receiveShadow !== false;
      const m = model.material || {};
      object.material.color.set(m.color || '#8b5cf6');
      object.material.metalness = m.metalness ?? 0.35;
      object.material.roughness = m.roughness ?? 0.3;
      object.material.emissive.set(m.emissive || '#000000');
      object.material.emissiveIntensity = m.emissiveIntensity ?? 0;
      object.material.opacity = m.opacity ?? 1;
      object.material.transparent = (m.opacity ?? 1) < 1;
      object.material.wireframe = !!m.wireframe;
      object.material.flatShading = !!m.flatShading;
      object.material.needsUpdate = true;
    }
    if (model.kind === 'light' && object.isLight) {
      const l = model.light || {};
      object.color.set(l.color || '#ffffff');
      object.intensity = l.intensity ?? object.intensity;
      if (object.distance !== undefined) object.distance = l.distance ?? object.distance;
      if (object.angle !== undefined) object.angle = l.angle ?? object.angle;
      if (object.penumbra !== undefined) object.penumbra = l.penumbra ?? object.penumbra;
      object.castShadow = model.castShadow !== false && (l.type === 'directional' || l.type === 'spot');
    }
    if (model.kind === 'imported') {
      object.traverse((node) => {
        if (node.isMesh) {
          node.castShadow = model.castShadow !== false;
          node.receiveShadow = model.receiveShadow !== false;
        }
      });
    }
  }

  applyEditorCamera(config, instant = false) {
    if (!config) return;
    if (instant) {
      this.camera.position.fromArray(config.position || [7, 4.5, 9]);
      this.orbit.target.fromArray(config.target || [0, 1, 0]);
      this.orbit.update();
    } else {
      this.tweenCamera(new THREE.Vector3().fromArray(config.position), new THREE.Vector3().fromArray(config.target));
    }
  }

  applySettings(settings = {}) {
    const color = new THREE.Color(settings.background || '#060913');
    this.scene.background = color;
    this.scene.fog = settings.fog === false ? null : new THREE.FogExp2(color, 0.021);
    this.scene.environmentIntensity = settings.environment ?? 0.55;
    this.renderer.shadowMap.enabled = settings.shadows !== false;
    this.renderer.shadowMap.needsUpdate = true;
    this.grid.visible = settings.grid !== false && !this.liveCamera;
    this.ground.visible = true;
  }

  setSelection(id) {
    this.selectedId = id;
    const entry = id ? this.runtime.get(id) : null;
    if (!entry || this.liveCamera) {
      this.transform.detach();
      this.selection.visible = false;
      return;
    }
    if (entry.kind === 'camera') {
      this.transform.attach(this.shotCamera);
    } else {
      this.transform.attach(entry.object3d);
    }
    this.transform.getHelper().visible = true;
    this.selection.visible = true;
    this.updateSelection();
  }

  updateSelection() {
    const entry = this.selectedId ? this.runtime.get(this.selectedId) : null;
    if (!entry || this.liveCamera) {
      this.selection.visible = false;
      return;
    }
    const object = entry.object3d;
    object.updateWorldMatrix(true, true);
    if (entry.kind === 'light' || entry.kind === 'camera') {
      object.getWorldPosition(_center);
      _size.set(0.45, 0.45, 0.45);
    } else {
      _box.setFromObject(object);
      if (_box.isEmpty()) {
        object.getWorldPosition(_center);
        _size.set(0.4, 0.4, 0.4);
      } else {
        _box.getSize(_size);
        _box.getCenter(_center);
        _size.multiplyScalar(1.08);
        _size.x = Math.max(_size.x, 0.18);
        _size.y = Math.max(_size.y, 0.18);
        _size.z = Math.max(_size.z, 0.18);
      }
    }
    this.selection.position.copy(_center);
    this.selection.scale.copy(_size);
    this.selection.visible = true;
  }

  applyTime(time) {
    this.currentTime = time;
    if (!this.project) return;
    for (const model of this.project.objects) {
      const entry = this.runtime.get(model.id);
      if (!entry || model.kind === 'camera') continue;
      const p = sampleTrack(model.keyframes?.position, time);
      if (p) entry.object3d.position.fromArray(p);
      const r = sampleTrack(model.keyframes?.rotation, time);
      if (r) entry.object3d.rotation.set(r[0], r[1], r[2]);
      const s = sampleTrack(model.keyframes?.scale, time);
      if (s) entry.object3d.scale.fromArray(s);
      if (entry.activeAction && model.clip) {
        const clip = entry.activeAction.getClip();
        const speed = model.clip.speed ?? 1;
        let local = time * speed;
        if (model.clip.loop === false) local = Math.min(local, clip.duration);
        else local = ((local % clip.duration) + clip.duration) % clip.duration;
        entry.mixer.setTime(local);
      }
    }
    this.applyCameraTime(time);
    this.updateSelection();
  }

  applyCameraTime(time) {
    if (!this.project) return;
    const model = this.project.objects.find((o) => o.kind === 'camera');
    if (!model) return;
    const entry = this.runtime.get(model.id);
    if (!entry) return;
    const pos = sampleTrack(model.keyframes?.position, time);
    if (pos) this.shotCamera.position.fromArray(pos);
    else this.shotCamera.position.fromArray(model.transform.position);
    const target = sampleTrack(model.keyframes?.target, time) || model.target || [0, 1.2, 0];
    this.shotCamera.up.set(0, 1, 0);
    this.shotCamera.lookAt(target[0], target[1], target[2]);
    const fov = model.fov || 45;
    if (this.shotCamera.fov !== fov) {
      this.shotCamera.fov = fov;
    }
    this.shotCamera.updateProjectionMatrix();
  }

  lookAtCamera(target = [0, 1.2, 0]) {
    this.shotCamera.up.set(0, 1, 0);
    this.shotCamera.lookAt(target[0], target[1], target[2]);
  }

  readTransform(id) {
    const entry = this.runtime.get(id);
    if (!entry) return null;
    const object = entry.object3d;
    return {
      position: [object.position.x, object.position.y, object.position.z],
      rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
      scale: [object.scale.x, object.scale.y, object.scale.z],
    };
  }

  getBounds(id) {
    const entry = this.runtime.get(id);
    if (!entry) return null;
    const object = entry.object3d;
    object.updateWorldMatrix(true, true);
    if (entry.kind === 'camera') {
      object.getWorldPosition(_center);
      return { center: _center.clone(), size: new THREE.Vector3(0.4, 0.4, 0.4), empty: true };
    }
    _box.setFromObject(object);
    if (_box.isEmpty()) {
      object.getWorldPosition(_center);
      return { center: _center.clone(), size: new THREE.Vector3(0.4, 0.4, 0.4), empty: true };
    }
    _box.getSize(_size);
    _box.getCenter(_center);
    return { center: _center.clone(), size: _size.clone(), empty: false };
  }

  focusObject(id) {
    const bounds = this.getBounds(id);
    if (!bounds) return;
    const radius = Math.max(bounds.size.length() * 0.55, 0.9);
    const fov = (this.camera.fov * Math.PI) / 180;
    const distance = clamp((radius / Math.sin(fov / 2)) * 1.15, 2.2, 40);
    _dir.copy(this.camera.position).sub(this.orbit.target);
    if (_dir.lengthSq() < 0.0001) _dir.set(1, 0.7, 1);
    _dir.normalize();
    const to = bounds.center.clone().addScaledVector(_dir, distance);
    this.tweenCamera(to, bounds.center, 0.5);
  }

  setView(name) {
    const target = this.orbit.target.clone();
    const distance = Math.max(this.camera.position.distanceTo(target), 5);
    let pos;
    if (name === 'front') pos = target.clone().add(new THREE.Vector3(0, 0, distance));
    else if (name === 'side') pos = target.clone().add(new THREE.Vector3(distance, 0, 0.001));
    else if (name === 'top') pos = target.clone().add(new THREE.Vector3(0.001, distance, 0.001));
    else pos = target.clone().add(new THREE.Vector3(0.62, 0.45, 0.72).normalize().multiplyScalar(distance));
    this.tweenCamera(pos, target, 0.45);
  }

  tweenCamera(position, target, duration = 0.45) {
    this.tween = {
      fromPos: this.camera.position.clone(),
      fromTarget: this.orbit.target.clone(),
      toPos: position.clone(),
      toTarget: target.clone(),
      elapsed: 0,
      duration,
    };
  }

  setLiveCamera(enabled) {
    this.liveCamera = !!enabled;
    this.orbit.enabled = !enabled;
    this.transform.enabled = !enabled;
    this.transform.getHelper().visible = !enabled;
    if (enabled) {
      this.transform.detach();
      this.selection.visible = false;
    } else {
      this.setSelection(this.selectedId);
    }
    this.applySettings(this.project?.settings);
    this.updateSelection();
  }

  setClipSettings(id, index, enabled, speed) {
    const model = this.project?.objects.find((o) => o.id === id);
    const entry = this.runtime.get(id);
    if (!model || !entry) return;
    model.clip = { ...(model.clip || {}), index, enabled, speed };
    this.configureClip(entry, model);
    this.applyTime(this.currentTime);
  }

  update(dt) {
    if (!this.liveCamera) this.orbit.update();
    if (this.tween) {
      this.tween.elapsed += dt;
      const t = clamp(this.tween.elapsed / this.tween.duration, 0, 1);
      const e = easeOutCubic(t);
      this.camera.position.lerpVectors(this.tween.fromPos, this.tween.toPos, e);
      this.orbit.target.lerpVectors(this.tween.fromTarget, this.tween.toTarget, e);
      this.camera.lookAt(this.orbit.target);
      if (t >= 1) this.tween = null;
    }
    if (this.dust) this.dust.rotation.y += dt * 0.008;
    this.updateSelection();
  }

  render() {
    const camera = this.liveCamera ? this.shotCamera : this.camera;
    this.renderer.render(this.scene, camera);
  }

  getCamera() {
    return this.liveCamera ? this.shotCamera : this.camera;
  }

  resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.shotCamera.aspect = width / height;
    this.shotCamera.updateProjectionMatrix();
  }

  async exportGLB() {
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const exporter = new GLTFExporter();
    const duration = this.project?.settings?.duration || 6;
    const fps = this.project?.settings?.fps || 30;
    const steps = Math.max(2, Math.round(duration * fps));
    const times = new Float32Array(steps + 1);
    for (let i = 0; i <= steps; i += 1) times[i] = (i / steps) * duration;

    const animations = [];
    const tmpEuler = new THREE.Euler();
    const tmpQuat = new THREE.Quaternion();
    const tmpPos = new THREE.Vector3();
    const tmpTarget = new THREE.Vector3();
    const lookMatrix = new THREE.Matrix4();

    for (const model of this.project.objects) {
      if (model.visible === false) continue;
      const entry = this.runtime.get(model.id);
      if (!entry) continue;
      const object = entry.object3d;
      const tracks = [];
      const hasPos = model.keyframes?.position?.length;
      const hasRot = model.keyframes?.rotation?.length;
      const hasScale = model.keyframes?.scale?.length;
      const hasTarget = model.keyframes?.target?.length;

      if (hasPos) {
        const values = new Float32Array((steps + 1) * 3);
        for (let i = 0; i <= steps; i += 1) {
          const p = sampleTrack(model.keyframes.position, times[i]);
          values.set(p, i * 3);
        }
        tracks.push(new THREE.VectorKeyframeTrack(`${object.uuid}.position`, times, values));
      }
      if (hasRot) {
        const values = new Float32Array((steps + 1) * 4);
        for (let i = 0; i <= steps; i += 1) {
          const r = sampleTrack(model.keyframes.rotation, times[i]);
          tmpEuler.set(r[0], r[1], r[2]);
          tmpQuat.setFromEuler(tmpEuler);
          values.set([tmpQuat.x, tmpQuat.y, tmpQuat.z, tmpQuat.w], i * 4);
        }
        tracks.push(new THREE.QuaternionKeyframeTrack(`${object.uuid}.quaternion`, times, values));
      }
      if (hasScale) {
        const values = new Float32Array((steps + 1) * 3);
        for (let i = 0; i <= steps; i += 1) {
          const s = sampleTrack(model.keyframes.scale, times[i]);
          values.set(s, i * 3);
        }
        tracks.push(new THREE.VectorKeyframeTrack(`${object.uuid}.scale`, times, values));
      }
      if (model.kind === 'camera' && (hasPos || hasTarget)) {
        const values = new Float32Array((steps + 1) * 4);
        for (let i = 0; i <= steps; i += 1) {
          const p = sampleTrack(model.keyframes.position, times[i]) || model.transform.position;
          const target = sampleTrack(model.keyframes.target, times[i]) || model.target || [0, 1.2, 0];
          tmpPos.fromArray(p);
          tmpTarget.fromArray(target);
          lookMatrix.lookAt(tmpPos, tmpTarget, new THREE.Vector3(0, 1, 0));
          tmpQuat.setFromRotationMatrix(lookMatrix);
          values.set([tmpQuat.x, tmpQuat.y, tmpQuat.z, tmpQuat.w], i * 4);
        }
        tracks.push(new THREE.QuaternionKeyframeTrack(`${object.uuid}.quaternion`, times, values));
      }
      if (tracks.length) {
        animations.push(new THREE.AnimationClip(model.name || 'Animação', duration, tracks));
      }
      if (entry.clips?.length) {
        entry.clips.forEach((clip) => animations.push(clip));
      }
    }

    this.transform.detach();
    const prevHelpers = this.helpers.visible;
    const prevSelection = this.selection.visible;
    this.helpers.visible = false;
    this.selection.visible = false;
    this.applyTime(0);
    try {
      const result = await exporter.parseAsync(this.scene, {
        binary: true,
        animations,
        onlyVisible: true,
      });
      return result;
    } finally {
      this.helpers.visible = prevHelpers;
      this.selection.visible = prevSelection;
      this.applyTime(this.currentTime);
      this.setSelection(this.selectedId);
    }
  }
}

export { base64ToArrayBuffer };
