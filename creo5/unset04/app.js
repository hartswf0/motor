import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.179.1/build/three.module.js';
import { Sky } from 'https://cdn.jsdelivr.net/npm/three@0.179.1/examples/jsm/objects/Sky.js';
import initJolt from 'https://cdn.jsdelivr.net/npm/jolt-physics@1.1.0/dist/jolt-physics.wasm-compat.js';
import { Heightfield } from '../src/core/place.js';
import { BAR, LINK, GARAGE } from '../designs/henry-house/geometry.mjs';

const $ = id => document.getElementById(id);
const mobile = matchMedia('(pointer:coarse)').matches || innerWidth < 820;
const safeMode = mobile || new URLSearchParams(location.search).has('safe');
const FT = 0.3048;
const IN = 0.0254;

const state = {
  mode:'drive', cameraMode:0, trees:true, showDrive:true, showParcel:true, showHouse:true,
  input:{forward:0, steer:0, handbrake:false}, footprint:'point', siteIndex:0,
  ghost:null, target:null, key:'', model:'gpt-5.1'
};

let place, placeEntities=[], driveData, siteFit, terrain, terrainMesh, terrainBody, terrainDatum=0;
let scene, renderer, camera, raycaster, clock, sun;
let Jolt, jolt, physicsSystem, bodyInterface;
let roadGroup, parcelGroup, forestGroup, houseGroup, builtGroup, ghostGroup;
let car, carBody, carConstraint, carController, wheelMeshes=[];
let toastTimer=0, loopStarted=false, uiBound=false, forestBuilding=false;

const LAYER_STATIC=0, LAYER_MOVING=1, NUM_LAYERS=2;
const THREE_UP=new THREE.Vector3(0,1,0);
const LOCAL_Z=new THREE.Vector3(0,0,1);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const deg=d=>d*Math.PI/180;
const jq=q=>new Jolt.Quat(q.x,q.y,q.z,q.w);
const tv=v=>new THREE.Vector3(v.GetX(),v.GetY(),v.GetZ());
const tq=q=>new THREE.Quaternion(q.GetX(),q.GetY(),q.GetZ(),q.GetW());
const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(()=>resolve()));
const idle=()=>new Promise(resolve=>{
  if('requestIdleCallback' in window) requestIdleCallback(()=>resolve(),{timeout:90});
  else setTimeout(resolve,0);
});

function toast(msg){
  const e=$('toast'); if(!e)return;
  e.textContent=msg;e.classList.add('on');clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>e.classList.remove('on'),2200);
}
function setStatus(id,text){const e=$(id);if(e)e.textContent=text}
function bootStage(text,pct){
  const boot=$('boot');
  if(!boot)return;
  const label=boot.querySelector('span'), bar=boot.querySelector('.bootBar i');
  if(label)label.textContent=text;
  if(bar){bar.style.animation='none';bar.style.transform='none';bar.style.width=`${clamp(pct,2,100)}%`;bar.style.transition='width .22s ease'}
}
function setMode(mode){
  state.mode=mode;
  document.body.classList.toggle('map',mode==='map');
  document.body.classList.toggle('building',mode==='build');
  $('modeLabel').textContent=mode.toUpperCase();
  document.querySelectorAll('#dock button').forEach(b=>b.classList.toggle('on',b.dataset.mode===mode));
  document.querySelectorAll('.sheet').forEach(s=>s.classList.remove('on'));
  if(mode==='build')$('buildSheet').classList.add('on');
  if(mode==='world')$('worldSheet').classList.add('on');
  if(mode==='map'&&terrain) enterMap();
  else if(car){camera.fov=62;camera.updateProjectionMatrix()}
}
function openWorld(){setMode('world');updateSiteReadout()}

async function fetchText(url,label){
  const r=await fetch(url,{cache:'force-cache'});
  if(!r.ok)throw Error(`${label} ${r.status}`);
  return r.text();
}
async function fetchJSON(url,label){
  const r=await fetch(url,{cache:'force-cache'});
  if(!r.ok)throw Error(`${label} ${r.status}`);
  return r.json();
}

async function boot(){
  try{
    setupRenderer();
    setupUI();
    startLoop();
    bootStage('starting renderer',5);
    await nextFrame();

    bootStage('loading CREO terrain + access',12);
    const placePromise=fetchText('../places/hwy-321-johnson-064-03.json','place');
    const drivePromise=fetchJSON('../data/drive-traced.json','drive');
    const fitPromise=fetchJSON('../site-fit.json','sites');
    const joltPromise=initJolt();
    const [placeText,driveRes,fitRes,J]=await Promise.all([placePromise,drivePromise,fitPromise,joltPromise]);
    driveData=driveRes;siteFit=fitRes;Jolt=J;
    await nextFrame();

    // The game needs the CREO place, not World's journal/index/derived-relation machinery.
    // Parse only the immutable place snapshot and reconstruct its canonical Heightfield.
    bootStage('decoding CREO ground',27);
    const saved=JSON.parse(placeText);
    const pj=saved.place;
    if(!pj?.terrain)throw Error('CREO place has no terrain');
    place={
      id:pj.id,name:pj.name,meta:pj.meta||null,
      terrain:Heightfield.fromJSON(pj.terrain)
    };
    placeEntities=Array.isArray(pj.entities)?pj.entities:[];
    saved.journal=null;
    setStatus('worldStatus','CREO · REAL PLACE');
    await nextFrame();

    bootStage('starting Jolt physics',37);
    initPhysics();
    await nextFrame();

    bootStage('sampling mountain',45);
    await compileTerrainAsync();
    await nextFrame();

    bootStage('drawing parcel + road',68);
    buildContext();
    buildRoad();
    await nextFrame();

    bootStage('placing Henry House',76);
    buildHenryHouse();
    await nextFrame();

    bootStage('assembling 4×4',84);
    createVehicle();
    await nextFrame();

    document.body.classList.add('ready');
    setStatus('physicsStatus','JOLT · LIVE');
    setStatus('worldStatus',safeMode?'CREO · GAME GROUND · SAFE':'CREO · GAME GROUND');
    bootStage('ready',100);
    toast('mountain ready');

    // Vegetation is atmosphere, not a boot dependency. Grow it after the player can drive.
    buildForestAsync().catch(err=>console.warn('forest',err));
  }catch(err){
    console.error(err);
    setStatus('worldStatus','BOOT FAILED');
    const boot=$('boot');
    if(boot)boot.innerHTML=`<b>BOOT FAILED</b><span>${String(err.message||err)}</span>`;
  }
}

function setupRenderer(){
  renderer=new THREE.WebGLRenderer({canvas:$('gl'),antialias:!safeMode,powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio,safeMode?1:1.6));
  renderer.setSize(innerWidth,innerHeight,false);
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=1.06;
  renderer.shadowMap.enabled=!safeMode;
  renderer.shadowMap.type=THREE.PCFSoftShadowMap;

  scene=new THREE.Scene();
  scene.background=new THREE.Color(0xb9c8c9);
  scene.fog=new THREE.FogExp2(0xb3c2c4,safeMode?.00145:.0010);
  camera=new THREE.PerspectiveCamera(62,innerWidth/innerHeight,.08,5000);
  camera.position.set(0,12,26);
  raycaster=new THREE.Raycaster();
  clock=new THREE.Clock();

  const sky=new Sky();
  sky.scale.setScalar(10000);
  sky.material.uniforms.turbidity.value=5.5;
  sky.material.uniforms.rayleigh.value=1.5;
  sky.material.uniforms.mieCoefficient.value=.008;
  sky.material.uniforms.mieDirectionalG.value=.84;
  sun=new THREE.Vector3().setFromSphericalCoords(1,deg(50),deg(230));
  sky.material.uniforms.sunPosition.value.copy(sun).multiplyScalar(10000);
  scene.add(sky);

  const dl=new THREE.DirectionalLight(0xfff0d6,2.65);
  dl.position.copy(sun).multiplyScalar(700);
  dl.castShadow=!safeMode;
  dl.shadow.mapSize.set(safeMode?512:1024,safeMode?512:1024);
  Object.assign(dl.shadow.camera,{left:-150,right:150,top:150,bottom:-150,near:1,far:1800});
  scene.add(dl);
  scene.add(new THREE.HemisphereLight(0xbcd2df,0x2f3429,1.35));

  builtGroup=new THREE.Group();
  ghostGroup=new THREE.Group();
  scene.add(builtGroup,ghostGroup);

  addEventListener('resize',()=>{
    camera.aspect=innerWidth/innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth,innerHeight,false);
  });
}

function initPhysics(){
  const settings=new Jolt.JoltSettings();
  settings.mMaxWorkerThreads=1;
  const pair=new Jolt.ObjectLayerPairFilterTable(NUM_LAYERS);
  pair.EnableCollision(LAYER_STATIC,LAYER_MOVING);
  pair.EnableCollision(LAYER_MOVING,LAYER_MOVING);
  const bpStatic=new Jolt.BroadPhaseLayer(0),bpMoving=new Jolt.BroadPhaseLayer(1);
  const bp=new Jolt.BroadPhaseLayerInterfaceTable(NUM_LAYERS,2);
  bp.MapObjectToBroadPhaseLayer(LAYER_STATIC,bpStatic);
  bp.MapObjectToBroadPhaseLayer(LAYER_MOVING,bpMoving);
  settings.mObjectLayerPairFilter=pair;
  settings.mBroadPhaseLayerInterface=bp;
  settings.mObjectVsBroadPhaseLayerFilter=
    new Jolt.ObjectVsBroadPhaseLayerFilterTable(bp,2,pair,NUM_LAYERS);
  jolt=new Jolt.JoltInterface(settings);
  Jolt.destroy(settings);
  physicsSystem=jolt.GetPhysicsSystem();
  bodyInterface=physicsSystem.GetBodyInterface();
}

async function compileTerrainAsync(){
  const hf=place.terrain;
  const b=hf.bounds;
  const x0=b[0],x1=b[2],n0=b[1],n1=b[3];
  const z0=-n1,z1=-n0;
  // Keep the first playable field deliberately modest. CREO remains full-resolution source.
  const N=safeMode?65:129;
  const dx=(x1-x0)/(N-1),dz=(z1-z0)/(N-1);
  const heights=new Float32Array(N*N);
  let lo=Infinity,hi=-Infinity;

  for(let j=0;j<N;j++){
    for(let i=0;i<N;i++){
      const x=x0+i*dx,z=z0+j*dz,h=hf.heightAt(x,-z);
      heights[j*N+i]=h;lo=Math.min(lo,h);hi=Math.max(hi,h);
    }
    if((j&7)===7){
      bootStage(`sampling mountain ${Math.round((j+1)/N*100)}%`,45+Math.round((j+1)/N*8));
      await nextFrame();
    }
  }

  terrainDatum=Math.floor(lo/10)*10;
  for(let i=0;i<heights.length;i++)heights[i]-=terrainDatum;
  terrain={x0,x1,z0,z1,N,dx,dz,heights,lo:lo-terrainDatum,hi:hi-terrainDatum};

  const pos=new Float32Array(N*N*3);
  const cols=new Float32Array(N*N*3);
  const indexCount=(N-1)*(N-1)*6;
  const idx=N*N>65535?new Uint32Array(indexCount):new Uint16Array(indexCount);
  const c=new THREE.Color();
  const H=(i,j)=>heights[clamp(j,0,N-1)*N+clamp(i,0,N-1)];

  for(let j=0;j<N;j++){
    for(let i=0;i<N;i++){
      const k=j*N+i,x=x0+i*dx,z=z0+j*dz,h=H(i,j);
      pos[k*3]=x;pos[k*3+1]=h;pos[k*3+2]=z;
      const sx=(H(i+1,j)-H(i-1,j))/(2*dx);
      const sz=(H(i,j+1)-H(i,j-1))/(2*dz);
      const s=Math.hypot(sx,sz);
      const t=(h-terrain.lo)/Math.max(1,terrain.hi-terrain.lo);
      if(s>.72)c.setHSL(.08,.12,.28+Math.min(.1,t*.1));
      else if(s>.38)c.setHSL(.09,.28,.25+t*.08);
      else c.setHSL(.25,.30,.20+t*.12);
      cols[k*3]=c.r;cols[k*3+1]=c.g;cols[k*3+2]=c.b;
    }
    if((j&15)===15)await nextFrame();
  }

  let q=0;
  for(let j=0;j<N-1;j++)for(let i=0;i<N-1;i++){
    const a=j*N+i,b0=a+1,d=(j+1)*N+i,cc=d+1;
    idx[q++]=a;idx[q++]=d;idx[q++]=b0;idx[q++]=b0;idx[q++]=d;idx[q++]=cc;
  }

  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.BufferAttribute(pos,3));
  g.setAttribute('color',new THREE.BufferAttribute(cols,3));
  g.setIndex(new THREE.BufferAttribute(idx,1));
  g.computeVertexNormals();
  const mat=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.99,metalness:0});
  terrainMesh=new THREE.Mesh(g,mat);
  terrainMesh.receiveShadow=true;
  scene.add(terrainMesh);
  await nextFrame();

  bootStage('compiling physical mountain',60);
  const hs=new Jolt.HeightFieldShapeSettings();
  hs.mOffset.Set(x0,0,z0);
  hs.mScale.Set(dx,1,dz);
  hs.mSampleCount=N;
  hs.mBlockSize=2;
  hs.mHeightSamples.resize(N*N);
  new Float32Array(Jolt.HEAPF32.buffer,Jolt.getPointer(hs.mHeightSamples.data()),N*N).set(heights);
  const result=hs.Create();
  if(result.HasError?.())throw Error(`Jolt terrain: ${result.GetError?.()||'shape error'}`);
  const shape=result.Get();
  const cs=new Jolt.BodyCreationSettings(
    shape,new Jolt.RVec3(0,0,0),new Jolt.Quat(0,0,0,1),
    Jolt.EMotionType_Static,LAYER_STATIC
  );
  cs.mFriction=.78;
  terrainBody=bodyInterface.CreateBody(cs);
  bodyInterface.AddBody(terrainBody.GetID(),Jolt.EActivation_DontActivate);
  Jolt.destroy(cs);
  Jolt.destroy(hs);
}

function groundAt(x,z){
  if(!terrain)return 0;
  const {x0,z0,dx,dz,N,heights}=terrain;
  const fx=clamp((x-x0)/dx,0,N-1.001),fz=clamp((z-z0)/dz,0,N-1.001);
  const i=Math.floor(fx),j=Math.floor(fz),u=fx-i,v=fz-j;
  const h00=heights[j*N+i],h10=heights[j*N+i+1],
        h01=heights[(j+1)*N+i],h11=heights[(j+1)*N+i+1];
  // Match CREO's triangle diagonal instead of a second bilinear surface.
  return v<=u
    ? h00+(h10-h00)*u+(h11-h10)*v
    : h00+(h11-h01)*u+(h01-h00)*v;
}
function slopeAt(x,z){
  const d=terrain?.dx||2;
  return Math.hypot(
    (groundAt(x+d,z)-groundAt(x-d,z))/(2*d),
    (groundAt(x,z+d)-groundAt(x,z-d))/(2*d)
  );
}

function buildContext(){
  parcelGroup=new THREE.Group();
  scene.add(parcelGroup);
  const entities=placeEntities;
  const parcel=entities.find(e=>e.type==='parcel'||e.subtype==='parcel');
  const ring=parcel?.footprint||null;
  if(ring?.length){
    const pts=ring.map(([x,n])=>new THREE.Vector3(x,groundAt(x,-n)+.55,-n));
    pts.push(pts[0].clone());
    parcelGroup.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({color:0xffe36a,transparent:true,opacity:.94})
    ));
  }

  // Collapse potentially thousands of imported path features into two draw calls.
  const roadPos=[],waterPos=[];
  let features=0;
  for(const e of entities){
    if(!e.path||!['road','path','water','drain'].includes(e.type))continue;
    if(++features>500)break;
    const dst=e.type==='water'?waterPos:roadPos;
    const step=Math.max(1,Math.ceil(e.path.length/180));
    for(let i=step;i<e.path.length;i+=step){
      const a=e.path[i-step],b=e.path[Math.min(i,e.path.length-1)];
      dst.push(a[0],groundAt(a[0],-a[1])+.28,-a[1]);
      dst.push(b[0],groundAt(b[0],-b[1])+.28,-b[1]);
    }
  }
  const addSegments=(array,color,opacity)=>{
    if(!array.length)return;
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.Float32BufferAttribute(array,3));
    parcelGroup.add(new THREE.LineSegments(g,new THREE.LineBasicMaterial({color,transparent:true,opacity})));
  };
  addSegments(roadPos,0xa6aaa3,.34);
  addSegments(waterPos,0x70a8c9,.58);
}

function buildRoad(){
  roadGroup=new THREE.Group();
  scene.add(roadGroup);
  const path=driveData?.paths?.['drive-main']?.local_m||[];
  if(path.length<2)return;
  const width=driveData?.paths?.['drive-main']?.width||3.5;
  const count=path.length-1;
  const mesh=new THREE.InstancedMesh(
    new THREE.BoxGeometry(1,1,1),
    new THREE.MeshStandardMaterial({color:0xd7d3c4,roughness:1}),
    count
  );
  const d=new THREE.Object3D();
  const dir=new THREE.Vector3(),mid=new THREE.Vector3();
  let n=0;
  for(let i=1;i<path.length;i++){
    const [ax,an]=path[i-1],[bx,bn]=path[i];
    const az=-an,bz=-bn,ay=groundAt(ax,az)+.09,by=groundAt(bx,bz)+.09;
    dir.set(bx-ax,by-ay,bz-az);
    const L=dir.length();
    if(L<.15)continue;
    mid.set((ax+bx)/2,(ay+by)/2,(az+bz)/2);
    d.position.copy(mid);
    d.quaternion.setFromUnitVectors(LOCAL_Z,dir.normalize());
    d.scale.set(width,.10,L+.24);
    d.updateMatrix();
    mesh.setMatrixAt(n++,d.matrix);
  }
  mesh.count=n;
  mesh.instanceMatrix.needsUpdate=true;
  mesh.receiveShadow=true;
  roadGroup.add(mesh);
  // No stack of road collision boxes: the road rests on the same physical heightfield.
}

function mulberry(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function nearDrive(x,z,limit=10){
  const p=driveData?.paths?.['drive-main']?.local_m||[];
  for(let i=1;i<p.length;i++){
    const a=[p[i-1][0],-p[i-1][1]],b=[p[i][0],-p[i][1]];
    const dx=b[0]-a[0],dz=b[1]-a[1],l2=dx*dx+dz*dz||1;
    const t=clamp(((x-a[0])*dx+(z-a[1])*dz)/l2,0,1);
    if(Math.hypot(x-a[0]-dx*t,z-a[1]-dz*t)<limit)return true;
  }
  return false;
}

async function buildForestAsync(){
  if(forestBuilding||!terrain)return;
  forestBuilding=true;
  forestGroup=new THREE.Group();
  scene.add(forestGroup);
  const count=safeMode?180:560,r=mulberry(6403);
  const trunk=new THREE.InstancedMesh(
    new THREE.CylinderGeometry(.12,.19,1,5),
    new THREE.MeshStandardMaterial({color:0x3d3328,roughness:1}),
    count
  );
  const crown=new THREE.InstancedMesh(
    new THREE.ConeGeometry(1,3.7,7),
    new THREE.MeshStandardMaterial({color:0x233b28,roughness:1}),
    count
  );
  const d=new THREE.Object3D();
  let n=0,tries=0;
  while(tries<count*7&&n<count){
    const stop=Math.min(tries+70,count*7);
    for(;tries<stop&&n<count;tries++){
      const x=lerp(terrain.x0,terrain.x1,r()),z=lerp(terrain.z0,terrain.z1,r());
      if(slopeAt(x,z)>.78||nearDrive(x,z,7))continue;
      const y=groundAt(x,z),s=.8+r()*1.35;
      d.position.set(x,y+2.5*s,z);d.scale.set(s,s,s);d.rotation.y=r()*Math.PI*2;d.updateMatrix();crown.setMatrixAt(n,d.matrix);
      d.position.set(x,y+.9*s,z);d.scale.set(s,s*1.8,s);d.updateMatrix();trunk.setMatrixAt(n,d.matrix);
      n++;
    }
    await idle();
  }
  crown.count=trunk.count=n;
  crown.instanceMatrix.needsUpdate=trunk.instanceMatrix.needsUpdate=true;
  forestGroup.add(trunk,crown);
  forestGroup.userData.epistemic='SIMULATED VEGETATION';
  forestBuilding=false;
}

function sitePlacement(){
  const list=siteFit?.best||siteFit?.top||[];
  const s=list[state.siteIndex]||{east_ft:0,north_ft:0,bearing_deg:252,cut_m3:0,fill_m3:0,naturalFall_ft:0};
  return {x:(s.east_ft||0)*FT,z:-(s.north_ft||0)*FT,bearing:252,raw:s,list};
}

function buildHenryHouse(){
  if(!terrain)return;
  if(houseGroup)scene.remove(houseGroup);
  houseGroup=new THREE.Group();
  scene.add(houseGroup);
  const p=sitePlacement(),y=groundAt(p.x,p.z)+.15;
  const mat=new THREE.MeshStandardMaterial({color:0x2b3030,roughness:.76});
  const glass=new THREE.MeshStandardMaterial({color:0x7ea2ad,roughness:.2,metalness:.05,transparent:true,opacity:.58});
  const roof=new THREE.MeshStandardMaterial({color:0x171b1c,roughness:.6});
  const addBox=(x0,x1,n0,n1,h,base,material=mat)=>{
    const w=(x1-x0)*IN,d=(n1-n0)*IN;
    const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material);
    m.position.set(((x0+x1)/2)*IN,base+h/2,-((n0+n1)/2)*IN);
    m.castShadow=!safeMode;m.receiveShadow=true;houseGroup.add(m);
  };
  addBox(BAR.x0,BAR.x1,BAR.y0,BAR.y1,6.1,0);
  addBox(BAR.x0,BAR.x1,BAR.y0,BAR.y0+5,4.2,2,glass);
  addBox(LINK.x0,LINK.x1,LINK.y0,LINK.y1,3.5,2.7);
  addBox(GARAGE.x0,GARAGE.x1,GARAGE.y0,GARAGE.y1,4,2.5);
  const mainRoof=new THREE.Mesh(new THREE.BoxGeometry(72*FT,.28,29*FT),roof);
  mainRoof.position.set(36*FT,6.5,-13*FT);mainRoof.rotation.z=deg(2.5);houseGroup.add(mainRoof);
  const gr=new THREE.Mesh(new THREE.BoxGeometry(28*FT,.28,27*FT),roof);
  gr.position.set(108*FT,6.8,-17*FT);gr.rotation.z=deg(2.5);houseGroup.add(gr);
  houseGroup.position.set(p.x,y,p.z);
  houseGroup.rotation.y=-deg(p.bearing);
  updateSiteReadout();
}

function updateSiteReadout(){
  if(!siteFit)return;
  const p=sitePlacement(),s=p.raw,total=p.list.length||1;
  $('siteReadout').textContent=
    `SITE ${state.siteIndex+1}/${total} · house 252° · cut ${Math.round(s.cut_m3||0)} m³ · fill ${Math.round(s.fill_m3||0)} m³ · natural fall ${(s.naturalFall_ft||0).toFixed(1)} ft`;
}

function createVehicle(){
  const path=driveData?.paths?.['drive-main']?.local_m||[];
  if(path.length<2)throw Error('existing drive has no usable path');
  const a=path[0],b=path[Math.min(2,path.length-1)];
  const x=a[0],z=-a[1],dx=b[0]-a[0],dz=-b[1]+a[1],heading=Math.atan2(dx,dz),y=groundAt(x,z)+2.1;
  const halfW=.93,halfH=.28,halfL=2.05,wheelR=.42,wheelWidth=.26;
  const shapeSettings=new Jolt.OffsetCenterOfMassShapeSettings(
    new Jolt.Vec3(0,-.32,0),
    new Jolt.BoxShapeSettings(new Jolt.Vec3(halfW,halfH,halfL))
  );
  const shape=shapeSettings.Create().Get();
  const rot=new THREE.Quaternion().setFromAxisAngle(THREE_UP,heading);
  const cs=new Jolt.BodyCreationSettings(shape,new Jolt.RVec3(x,y,z),jq(rot),Jolt.EMotionType_Dynamic,LAYER_MOVING);
  cs.mOverrideMassProperties=Jolt.EOverrideMassProperties_CalculateInertia;
  cs.mMassPropertiesOverride.mMass=1850;
  cs.mFriction=.9;
  carBody=bodyInterface.CreateBody(cs);
  bodyInterface.AddBody(carBody.GetID(),Jolt.EActivation_Activate);
  Jolt.destroy(cs);

  const vs=new Jolt.VehicleConstraintSettings();
  vs.mMaxPitchRollAngle=deg(72);
  vs.mWheels.clear();
  const wheelPos=[[halfW,-.25,1.35],[-halfW,-.25,1.35],[halfW,-.25,-1.35],[-halfW,-.25,-1.35]];
  wheelPos.forEach((p,i)=>{
    const w=new Jolt.WheelSettingsWV();
    w.mPosition=new Jolt.Vec3(...p);
    w.mRadius=wheelR;w.mWidth=wheelWidth;
    w.mSuspensionMinLength=.18;w.mSuspensionMaxLength=.58;
    w.mMaxSteerAngle=i<2?deg(31):0;
    w.mMaxHandBrakeTorque=i<2?0:5000;
    vs.mWheels.push_back(w);
  });

  const ctl=new Jolt.WheeledVehicleControllerSettings();
  ctl.mEngine.mMaxTorque=760;
  ctl.mEngine.mMinRPM=700;
  ctl.mEngine.mMaxRPM=6200;
  ctl.mTransmission.mClutchStrength=12;
  ctl.mDifferentials.clear();
  [[0,1],[2,3]].forEach(pair=>{
    const d=new Jolt.VehicleDifferentialSettings();
    d.mLeftWheel=pair[0];d.mRightWheel=pair[1];d.mEngineTorqueRatio=.5;d.mLimitedSlipRatio=1.7;
    ctl.mDifferentials.push_back(d);
  });
  ctl.mDifferentialLimitedSlipRatio=1.5;
  vs.mController=ctl;

  const ar1=new Jolt.VehicleAntiRollBar();ar1.mLeftWheel=0;ar1.mRightWheel=1;
  const ar2=new Jolt.VehicleAntiRollBar();ar2.mLeftWheel=2;ar2.mRightWheel=3;
  vs.mAntiRollBars.clear();vs.mAntiRollBars.push_back(ar1);vs.mAntiRollBars.push_back(ar2);

  carConstraint=new Jolt.VehicleConstraint(carBody,vs);
  carConstraint.SetVehicleCollisionTester(new Jolt.VehicleCollisionTesterCastCylinder(LAYER_MOVING,.08));
  physicsSystem.AddConstraint(carConstraint);
  carController=Jolt.castObject(carConstraint.GetController(),Jolt.WheeledVehicleController);

  car=new THREE.Group();
  const bodyMat=new THREE.MeshStandardMaterial({color:0xd85b27,roughness:.6,metalness:.15});
  const dark=new THREE.MeshStandardMaterial({color:0x171a17,roughness:.8});
  const body=new THREE.Mesh(new THREE.BoxGeometry(1.86,.62,4.1),bodyMat);
  body.position.y=.35;body.castShadow=!safeMode;car.add(body);
  const cab=new THREE.Mesh(new THREE.BoxGeometry(1.72,.72,1.85),dark);
  cab.position.set(0,.92,-.25);car.add(cab);
  wheelMeshes=[];
  for(let i=0;i<4;i++){
    const m=new THREE.Mesh(new THREE.CylinderGeometry(wheelR,wheelR,wheelWidth,14),dark);
    m.rotation.z=Math.PI/2;car.add(m);wheelMeshes.push(m);
  }
  scene.add(car);
}

function updateVehicleInput(){
  if(!carBody||!carController)return;
  let f=state.input.forward,s=state.input.steer,h=state.input.handbrake?1:0,b=0;
  const q=tq(carBody.GetRotation()).invert();
  const v=tv(carBody.GetLinearVelocity()).applyQuaternion(q).z;
  if(f&&Math.sign(f)!==Math.sign(v)&&Math.abs(v)>1.2){b=1;f=0}
  carController.SetDriverInput(f,s,b,h);
  if(f||s||b||h)bodyInterface.ActivateBody(carBody.GetID());
}
function updateVehicleVisual(){
  if(!carBody||!car||!carConstraint)return;
  const p=tv(carBody.GetPosition()),q=tq(carBody.GetRotation());
  car.position.copy(p);car.quaternion.copy(q);
  const right=new Jolt.Vec3(0,1,0),up=new Jolt.Vec3(1,0,0);
  wheelMeshes.forEach((m,i)=>{
    const t=carConstraint.GetWheelLocalTransform(i,right,up);
    m.position.copy(tv(t.GetTranslation()));
    m.quaternion.copy(tq(t.GetRotation().GetQuaternion()));
  });
  $('speed').textContent=Math.round(tv(carBody.GetLinearVelocity()).length()*2.23694);
  const forward=new THREE.Vector3(0,0,1).applyQuaternion(q);
  const p1=p.clone().addScaledVector(forward,3);
  const g=(groundAt(p1.x,p1.z)-groundAt(p.x,p.z))/3;
  $('grade').textContent=`${Math.round(g*100)}%`;
}
function recover(){
  if(!carBody)return;
  const p=tv(carBody.GetPosition()),y=groundAt(p.x,p.z)+2.2;
  bodyInterface.SetPositionAndRotation(
    carBody.GetID(),new Jolt.RVec3(p.x,y,p.z),
    Jolt.Quat.prototype.sIdentity(),Jolt.EActivation_Activate
  );
  bodyInterface.SetLinearVelocity(carBody.GetID(),new Jolt.Vec3(0,0,0));
  bodyInterface.SetAngularVelocity(carBody.GetID(),new Jolt.Vec3(0,0,0));
  toast('vehicle recovered');
}

function updateCamera(dt){
  if(!car||state.mode==='map')return;
  const p=car.position,q=car.quaternion;
  let local;
  if(state.cameraMode===0)local=new THREE.Vector3(0,4.2,-9.2);
  else if(state.cameraMode===1)local=new THREE.Vector3(0,1.65,1.15);
  else local=new THREE.Vector3(0,12,-18);
  const desired=p.clone().add(local.applyQuaternion(q));
  const target=p.clone().add(new THREE.Vector3(0,1.1,2.6).applyQuaternion(q));
  const t=1-Math.exp(-dt*(state.cameraMode===1?12:5));
  camera.position.lerp(desired,t);
  camera.up.lerp(THREE_UP,.1);
  camera.lookAt(target);
}
function enterMap(){
  if(!terrain)return;
  const cx=(terrain.x0+terrain.x1)/2,cz=(terrain.z0+terrain.z1)/2;
  const span=Math.max(terrain.x1-terrain.x0,terrain.z1-terrain.z0);
  camera.position.set(cx,Math.max(300,span*.82),cz+.01);
  camera.up.set(0,0,-1);
  camera.lookAt(cx,0,cz);
  camera.fov=48;
  camera.updateProjectionMatrix();
}

function aimGround(){
  if(!terrainMesh)return null;
  raycaster.setFromCamera(new THREE.Vector2(0,0),camera);
  return raycaster.intersectObject(terrainMesh,false)[0]?.point?.clone()||null;
}
function updateTarget(){
  if(state.mode!=='build'||!terrainMesh)return;
  state.target=aimGround();
  if(state.target)$('targetReadout').textContent=
    `${state.target.x.toFixed(1)} E · ${(-state.target.z).toFixed(1)} N · slope ${Math.round(slopeAt(state.target.x,state.target.z)*100)}%`;
}

function clearGhost(){ghostGroup.clear();state.ghost=null;$('ghostActions').hidden=true}
function primitiveProposal(prompt=''){
  const size=state.footprint==='large'?[24,14]:state.footprint==='small'?[12,8]:[8,6];
  const [w,d]=size;
  return {name:'FIELD PAVILION',primitives:[
    {type:'deck',x:0,z:0,w,d,h:.35,y:1.2,yaw:0,pitch:0},
    {type:'column',x:-w*.42,z:-d*.38,w:.35,d:.35,h:4.2,y:1.2,yaw:0,pitch:0},
    {type:'column',x:w*.42,z:-d*.38,w:.35,d:.35,h:4.2,y:1.2,yaw:0,pitch:0},
    {type:'column',x:-w*.42,z:d*.38,w:.35,d:.35,h:4.2,y:1.2,yaw:0,pitch:0},
    {type:'column',x:w*.42,z:d*.38,w:.35,d:.35,h:4.2,y:1.2,yaw:0,pitch:0},
    {type:'roof',x:0,z:0,w:w+2,d:d+2,h:.28,y:5.5,yaw:0,pitch:5},
    {type:'ramp',x:0,z:d*.72,w:3,d:8,h:.35,y:1.1,yaw:0,pitch:-11}
  ],note:prompt||'deterministic pavilion'};
}
function validateProposal(p){
  if(!p||!Array.isArray(p.primitives))throw Error('proposal has no primitives');
  if(p.primitives.length>40)throw Error('proposal too complex');
  const allowed=new Set(['box','wall','column','deck','roof','ramp']);
  p.primitives=p.primitives.map(o=>({
    type:allowed.has(o.type)?o.type:'box',
    x:clamp(+o.x||0,-35,35),z:clamp(+o.z||0,-35,35),
    w:clamp(+o.w||1,.15,30),d:clamp(+o.d||1,.15,30),h:clamp(+o.h||1,.12,16),
    y:clamp(+o.y||0,0,18),yaw:clamp(+o.yaw||0,-180,180),pitch:clamp(+o.pitch||0,-18,18)
  }));
  return p;
}
function showGhost(proposal){
  clearGhost();
  if(!state.target)throw Error('aim at ground first');
  proposal=validateProposal(proposal);
  const mat=new THREE.MeshBasicMaterial({color:0x6cf5e3,wireframe:true,transparent:true,opacity:.85});
  for(const o of proposal.primitives){
    const m=new THREE.Mesh(new THREE.BoxGeometry(o.w,o.h,o.d),mat);
    const gy=groundAt(state.target.x+o.x,state.target.z+o.z);
    m.position.set(state.target.x+o.x,gy+o.y+o.h/2,state.target.z+o.z);
    m.rotation.set(deg(o.pitch),deg(o.yaw),0);
    ghostGroup.add(m);
  }
  state.ghost={proposal,target:state.target.clone()};
  $('ghostActions').hidden=false;
  toast(`${proposal.name||'proposal'} · ghost only`);
}
function commitGhost(){
  if(!state.ghost)return;
  const mat=new THREE.MeshStandardMaterial({color:0x7a6044,roughness:.82});
  for(const o of state.ghost.proposal.primitives){
    const x=state.ghost.target.x+o.x,z=state.ghost.target.z+o.z;
    const gy=groundAt(x,z),y=gy+o.y+o.h/2;
    const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(deg(o.pitch),deg(o.yaw),0));
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(o.w,o.h,o.d),mat);
    mesh.position.set(x,y,z);mesh.quaternion.copy(q);mesh.castShadow=!safeMode;mesh.receiveShadow=true;
    builtGroup.add(mesh);
    const shape=new Jolt.BoxShape(new Jolt.Vec3(o.w/2,o.h/2,o.d/2),.03,null);
    const cs=new Jolt.BodyCreationSettings(shape,new Jolt.RVec3(x,y,z),jq(q),Jolt.EMotionType_Static,LAYER_STATIC);
    cs.mFriction=.85;
    const b=bodyInterface.CreateBody(cs);bodyInterface.AddBody(b.GetID(),Jolt.EActivation_DontActivate);Jolt.destroy(cs);
  }
  clearGhost();setMode('drive');toast('structure is now physical');
}

async function aiProposal(){
  const key=$('apiKey').value.trim()||state.key;
  if(!key){openWorld();toast('enter an API key in WORLD');return}
  if(!state.target){toast('aim at ground');return}
  const prompt=$('buildPrompt').value.trim();
  if(!prompt){toast('describe what to build');return}
  $('aiBuild').disabled=true;$('aiBuild').textContent='THINKING';

  const slope=Math.round(slopeAt(state.target.x,state.target.z)*100);
  const schema={type:'object',additionalProperties:false,required:['name','primitives','note'],properties:{
    name:{type:'string'},note:{type:'string'},
    primitives:{type:'array',minItems:1,maxItems:30,items:{type:'object',additionalProperties:false,
      required:['type','x','z','w','d','h','y','yaw','pitch'],
      properties:{
        type:{type:'string',enum:['box','wall','column','deck','roof','ramp']},
        x:{type:'number'},z:{type:'number'},w:{type:'number'},d:{type:'number'},
        h:{type:'number'},y:{type:'number'},yaw:{type:'number'},pitch:{type:'number'}
      }
    }}
  }};
  const instructions=`You are the CREO-UNSET world compiler. Design PLAYABLE structures from bounded box/ramp primitives. Coordinates are metres relative to the player's target. Preserve a driveable route, vehicle width 2 m, clearance 2.8 m. Ramps must be <= 18 degrees. Prefer one strong dominant silhouette. Return a proposal only; never code.`;

  try{
    const r=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
      body:JSON.stringify({
        model:$('modelName').value.trim()||'gpt-5.1',
        instructions,
        input:`PLAYER REQUEST: ${prompt}\nSITE: local slope ${slope}%, target E ${state.target.x.toFixed(1)} N ${(-state.target.z).toFixed(1)}. Existing access must remain clear.`,
        text:{format:{type:'json_schema',name:'creo_build',strict:true,schema}}
      })
    });
    const data=await r.json();
    if(!r.ok)throw Error(data?.error?.message||`API ${r.status}`);
    let text=data.output_text;
    if(!text)for(const item of data.output||[])for(const c of item.content||[])if(c.type==='output_text')text=c.text;
    if(!text)throw Error('model returned no proposal');
    showGhost(JSON.parse(text));
    state.key=key;
  }catch(err){
    console.error(err);toast(err.message||'AI failed');
  }finally{
    $('aiBuild').disabled=false;$('aiBuild').textContent='AI GHOST';
  }
}

function setupUI(){
  if(uiBound)return;
  uiBound=true;
  document.querySelectorAll('#dock button').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));
  document.querySelectorAll('.closeSheet').forEach(b=>b.addEventListener('click',()=>setMode('drive')));
  document.querySelectorAll('[data-footprint]').forEach(b=>b.addEventListener('click',()=>{
    state.footprint=b.dataset.footprint;
    document.querySelectorAll('[data-footprint]').forEach(x=>x.classList.toggle('on',x===b));
  }));
  $('basicBuild').addEventListener('click',()=>{
    if(!terrainMesh){toast('ground still compiling');return}
    if(!state.target)state.target=aimGround();
    if(!state.target){toast('aim at ground');return}
    showGhost(primitiveProposal($('buildPrompt').value));
  });
  $('aiBuild').addEventListener('click',aiProposal);
  $('rejectGhost').addEventListener('click',clearGhost);
  $('commitGhost').addEventListener('click',commitGhost);

  $('sitePrev').addEventListener('click',()=>{
    const list=siteFit?.best||siteFit?.top||[];
    if(!list.length)return;
    state.siteIndex=(state.siteIndex-1+list.length)%list.length;buildHenryHouse();
  });
  $('siteNext').addEventListener('click',()=>{
    const list=siteFit?.best||siteFit?.top||[];
    if(!list.length)return;
    state.siteIndex=(state.siteIndex+1)%list.length;buildHenryHouse();
  });

  $('treesToggle').addEventListener('change',e=>{state.trees=e.target.checked;if(forestGroup)forestGroup.visible=e.target.checked});
  $('driveToggle').addEventListener('change',e=>{state.showDrive=e.target.checked;if(roadGroup)roadGroup.visible=e.target.checked});
  $('parcelToggle').addEventListener('change',e=>{state.showParcel=e.target.checked;if(parcelGroup)parcelGroup.visible=e.target.checked});
  $('houseToggle').addEventListener('change',e=>{state.showHouse=e.target.checked;if(houseGroup)houseGroup.visible=e.target.checked});

  addEventListener('keydown',e=>{
    if(e.target.matches('input,textarea'))return;
    const k=e.key.toLowerCase();
    if(k==='w'||k==='arrowup')state.input.forward=1;
    if(k==='s'||k==='arrowdown')state.input.forward=-1;
    if(k==='a'||k==='arrowleft')state.input.steer=-1;
    if(k==='d'||k==='arrowright')state.input.steer=1;
    if(e.code==='Space'){e.preventDefault();state.input.handbrake=true}
    if(k==='c'){state.cameraMode=(state.cameraMode+1)%3;toast(['CHASE','HOOD','HIGH CHASE'][state.cameraMode])}
    if(k==='m')setMode(state.mode==='map'?'drive':'map');
    if(k==='b')setMode('build');
    if(k==='r')recover();
  });
  addEventListener('keyup',e=>{
    const k=e.key.toLowerCase();
    if(['w','s','arrowup','arrowdown'].includes(k))state.input.forward=0;
    if(['a','d','arrowleft','arrowright'].includes(k))state.input.steer=0;
    if(e.code==='Space')state.input.handbrake=false;
  });
  setupStick();
  $('handbrake').addEventListener('pointerdown',e=>{e.preventDefault();state.input.handbrake=true});
  ['pointerup','pointercancel','pointerleave'].forEach(ev=>$('handbrake').addEventListener(ev,()=>state.input.handbrake=false));
}

function setupStick(){
  const zone=$('stickZone'),stick=$('stick');
  let active=false,pid=null;
  const move=e=>{
    if(!active||e.pointerId!==pid)return;
    const r=zone.getBoundingClientRect(),dx=e.clientX-(r.left+r.width/2),dy=e.clientY-(r.top+r.height/2);
    const lim=r.width*.34,L=Math.hypot(dx,dy)||1,k=Math.min(1,lim/L),x=dx*k,y=dy*k;
    stick.style.transform=`translate(${x}px,${y}px)`;
    state.input.steer=clamp(x/lim,-1,1);state.input.forward=clamp(-y/lim,-1,1);
  };
  zone.addEventListener('pointerdown',e=>{active=true;pid=e.pointerId;zone.setPointerCapture(pid);move(e)});
  zone.addEventListener('pointermove',move);
  const end=e=>{
    if(e.pointerId!==pid)return;
    active=false;pid=null;stick.style.transform='translate(0,0)';state.input.steer=state.input.forward=0;
  };
  zone.addEventListener('pointerup',end);zone.addEventListener('pointercancel',end);
}

function startLoop(){
  if(loopStarted)return;
  loopStarted=true;
  clock.start();
  requestAnimationFrame(animate);
}
function animate(){
  requestAnimationFrame(animate);
  const dt=Math.min(clock.getDelta(),1/30);
  if(jolt){
    if(state.mode!=='map'&&carController)updateVehicleInput();
    jolt.Step(dt,dt>1/55?2:1);
  }
  if(carBody){
    updateVehicleVisual();
    updateCamera(dt);
  }
  if(terrainMesh)updateTarget();
  renderer.render(scene,camera);
}

boot();
