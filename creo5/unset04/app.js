import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.179.1/build/three.module.js';
import { Sky } from 'https://cdn.jsdelivr.net/npm/three@0.179.1/examples/jsm/objects/Sky.js';
import initJolt from 'https://cdn.jsdelivr.net/npm/jolt-physics@1.1.0/dist/jolt-physics.wasm-compat.js';
import { World } from '../src/core/world.js';
import { BAR, LINK, GARAGE } from '../designs/henry-house/geometry.mjs';

const $ = id => document.getElementById(id);
const mobile = matchMedia('(pointer:coarse)').matches || innerWidth < 820;
const FT = 0.3048;
const IN = 0.0254;
const state = {
  mode:'drive', cameraMode:0, trees:true, showDrive:true, showParcel:true, showHouse:true,
  input:{forward:0, steer:0, handbrake:false}, footprint:'point', siteIndex:0,
  ghost:null, target:null, key:'', model:'gpt-5.1'
};

let world, driveData, siteFit, terrain, terrainMesh, terrainBody, terrainDatum=0;
let scene, renderer, camera, raycaster, clock, sun;
let Jolt, jolt, physicsSystem, bodyInterface;
let roadGroup, parcelGroup, forestGroup, houseGroup, builtGroup, ghostGroup;
let car, carBody, carConstraint, carController, wheelMeshes=[];
let lastCarPos = new THREE.Vector3(), toastTimer=0;

const LAYER_STATIC=0, LAYER_MOVING=1, NUM_LAYERS=2;
const THREE_UP=new THREE.Vector3(0,1,0);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const smooth=(t)=>t*t*(3-2*t);
const deg=d=>d*Math.PI/180;
const jv=v=>new Jolt.Vec3(v.x,v.y,v.z);
const jrv=v=>new Jolt.RVec3(v.x,v.y,v.z);
const jq=q=>new Jolt.Quat(q.x,q.y,q.z,q.w);
const tv=v=>new THREE.Vector3(v.GetX(),v.GetY(),v.GetZ());
const tq=q=>new THREE.Quaternion(q.GetX(),q.GetY(),q.GetZ(),q.GetW());

function toast(msg){const e=$('toast');e.textContent=msg;e.classList.add('on');clearTimeout(toastTimer);toastTimer=setTimeout(()=>e.classList.remove('on'),2200)}
function setStatus(id,text){$(id).textContent=text}
function setMode(mode){
  state.mode=mode; document.body.classList.toggle('map',mode==='map'); document.body.classList.toggle('building',mode==='build');
  $('modeLabel').textContent=mode.toUpperCase(); document.querySelectorAll('#dock button').forEach(b=>b.classList.toggle('on',b.dataset.mode===mode));
  document.querySelectorAll('.sheet').forEach(s=>s.classList.remove('on'));
  if(mode==='build')$('buildSheet').classList.add('on'); if(mode==='world')$('worldSheet').classList.add('on');
  if(mode==='map') enterMap(); else if(car) camera.fov=62,camera.updateProjectionMatrix();
}
function openWorld(){setMode('world');updateSiteReadout()}

async function boot(){
  try{
    setupRenderer();
    const [placeText,driveRes,fitRes,J]=await Promise.all([
      fetch('../places/hwy-321-johnson-064-03.json',{cache:'force-cache'}).then(r=>{if(!r.ok)throw Error(`place ${r.status}`);return r.text()}),
      fetch('../data/drive-traced.json',{cache:'force-cache'}).then(r=>{if(!r.ok)throw Error(`drive ${r.status}`);return r.json()}),
      fetch('../site-fit.json',{cache:'force-cache'}).then(r=>{if(!r.ok)throw Error(`sites ${r.status}`);return r.json()}),
      initJolt()
    ]);
    world=World.load(placeText); driveData=driveRes; siteFit=fitRes; Jolt=J;
    setStatus('worldStatus','CREO · REAL PLACE');
    initPhysics();
    compileTerrain();
    buildContext();
    buildRoad();
    buildForest();
    buildHenryHouse();
    createVehicle();
    setupUI();
    document.body.classList.add('ready');
    setStatus('physicsStatus','JOLT · LIVE');
    animate();
  }catch(err){console.error(err);setStatus('worldStatus','BOOT FAILED');$('boot').innerHTML=`<b>BOOT FAILED</b><span>${String(err.message||err)}</span>`}
}

function setupRenderer(){
  renderer=new THREE.WebGLRenderer({canvas:$('gl'),antialias:!mobile,powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio,mobile?1.35:2)); renderer.setSize(innerWidth,innerHeight,false);
  renderer.outputColorSpace=THREE.SRGBColorSpace; renderer.toneMapping=THREE.ACESFilmicToneMapping; renderer.toneMappingExposure=1.08;
  renderer.shadowMap.enabled=!mobile; renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  scene=new THREE.Scene(); scene.background=new THREE.Color(0xb9c8c9); scene.fog=new THREE.FogExp2(0xb3c2c4,mobile?.00125:.0009);
  camera=new THREE.PerspectiveCamera(62,innerWidth/innerHeight,.08,5000); raycaster=new THREE.Raycaster(); clock=new THREE.Clock();
  const sky=new Sky(); sky.scale.setScalar(10000); sky.material.uniforms.turbidity.value=5.5; sky.material.uniforms.rayleigh.value=1.5; sky.material.uniforms.mieCoefficient.value=.008; sky.material.uniforms.mieDirectionalG.value=.84;
  sun=new THREE.Vector3().setFromSphericalCoords(1,deg(50),deg(230)); sky.material.uniforms.sunPosition.value.copy(sun).multiplyScalar(10000); scene.add(sky);
  const dl=new THREE.DirectionalLight(0xfff0d6,2.8); dl.position.copy(sun).multiplyScalar(700); dl.castShadow=!mobile; dl.shadow.mapSize.set(mobile?512:1536,mobile?512:1536); Object.assign(dl.shadow.camera,{left:-170,right:170,top:170,bottom:-170,near:1,far:1800}); scene.add(dl);
  scene.add(new THREE.HemisphereLight(0xbcd2df,0x2f3429,1.4)); builtGroup=new THREE.Group(); ghostGroup=new THREE.Group(); scene.add(builtGroup,ghostGroup);
  addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight,false)});
}

function initPhysics(){
  const settings=new Jolt.JoltSettings(); settings.mMaxWorkerThreads=1;
  const pair=new Jolt.ObjectLayerPairFilterTable(NUM_LAYERS); pair.EnableCollision(LAYER_STATIC,LAYER_MOVING); pair.EnableCollision(LAYER_MOVING,LAYER_MOVING);
  const bpStatic=new Jolt.BroadPhaseLayer(0),bpMoving=new Jolt.BroadPhaseLayer(1);
  const bp=new Jolt.BroadPhaseLayerInterfaceTable(NUM_LAYERS,2); bp.MapObjectToBroadPhaseLayer(LAYER_STATIC,bpStatic); bp.MapObjectToBroadPhaseLayer(LAYER_MOVING,bpMoving);
  settings.mObjectLayerPairFilter=pair; settings.mBroadPhaseLayerInterface=bp; settings.mObjectVsBroadPhaseLayerFilter=new Jolt.ObjectVsBroadPhaseLayerFilterTable(bp,2,pair,NUM_LAYERS);
  jolt=new Jolt.JoltInterface(settings); Jolt.destroy(settings); physicsSystem=jolt.GetPhysicsSystem(); bodyInterface=physicsSystem.GetBodyInterface();
}

function compileTerrain(){
  const hf=world.place.terrain; if(!hf)throw Error('CREO place has no terrain heightfield');
  const b=hf.bounds; const x0=b[0],x1=b[2],n0=b[1],n1=b[3];
  const z0=-n1,z1=-n0; const N=mobile?129:257;
  const dx=(x1-x0)/(N-1),dz=(z1-z0)/(N-1); const heights=new Float32Array(N*N);
  let lo=Infinity,hi=-Infinity;
  for(let j=0;j<N;j++)for(let i=0;i<N;i++){
    const x=x0+i*dx,z=z0+j*dz,n=-z,h=hf.heightAt(x,n); heights[j*N+i]=h;lo=Math.min(lo,h);hi=Math.max(hi,h);
  }
  terrainDatum=Math.floor(lo/10)*10; for(let i=0;i<heights.length;i++)heights[i]-=terrainDatum;
  terrain={x0,x1,z0,z1,N,dx,dz,heights,lo:lo-terrainDatum,hi:hi-terrainDatum};
  const pos=new Float32Array(N*N*3),cols=new Float32Array(N*N*3),idx=[]; const c=new THREE.Color();
  const H=(i,j)=>heights[clamp(j,0,N-1)*N+clamp(i,0,N-1)];
  for(let j=0;j<N;j++)for(let i=0;i<N;i++){
    const k=j*N+i,x=x0+i*dx,z=z0+j*dz,h=H(i,j); pos[k*3]=x;pos[k*3+1]=h;pos[k*3+2]=z;
    const sx=(H(i+1,j)-H(i-1,j))/(2*dx),sz=(H(i,j+1)-H(i,j-1))/(2*dz),s=Math.hypot(sx,sz); const t=(h-terrain.lo)/Math.max(1,terrain.hi-terrain.lo);
    if(s>.72)c.setHSL(.08,.12,.28+Math.min(.1,t*.1)); else if(s>.38)c.setHSL(.09,.28,.25+t*.08); else c.setHSL(.25,.30,.20+t*.12);
    cols[k*3]=c.r;cols[k*3+1]=c.g;cols[k*3+2]=c.b;
  }
  for(let j=0;j<N-1;j++)for(let i=0;i<N-1;i++){const a=j*N+i,b0=a+1,d=(j+1)*N+i,cc=d+1;idx.push(a,d,b0,b0,d,cc)}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(pos,3));g.setAttribute('color',new THREE.BufferAttribute(cols,3));g.setIndex(idx);g.computeVertexNormals();
  const mat=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.98,metalness:0}); terrainMesh=new THREE.Mesh(g,mat);terrainMesh.receiveShadow=true;scene.add(terrainMesh);
  // Jolt is compiled from the exact same resampled values drawn above.
  const hs=new Jolt.HeightFieldShapeSettings(); hs.mOffset.Set(x0,0,z0); hs.mScale.Set(dx,1,dz); hs.mSampleCount=N; hs.mBlockSize=2; hs.mHeightSamples.resize(N*N);
  new Float32Array(Jolt.HEAPF32.buffer,Jolt.getPointer(hs.mHeightSamples.data()),N*N).set(heights);
  const shape=hs.Create().Get(); const cs=new Jolt.BodyCreationSettings(shape,new Jolt.RVec3(0,0,0),new Jolt.Quat(0,0,0,1),Jolt.EMotionType_Static,LAYER_STATIC); cs.mFriction=.72;
  terrainBody=bodyInterface.CreateBody(cs);bodyInterface.AddBody(terrainBody.GetID(),Jolt.EActivation_DontActivate);Jolt.destroy(cs);
}

function groundAt(x,z){
  const {x0,z0,dx,dz,N,heights}=terrain; const fx=clamp((x-x0)/dx,0,N-1.001),fz=clamp((z-z0)/dz,0,N-1.001),i=Math.floor(fx),j=Math.floor(fz),u=fx-i,v=fz-j;
  const h00=heights[j*N+i],h10=heights[j*N+i+1],h01=heights[(j+1)*N+i],h11=heights[(j+1)*N+i+1]; return lerp(lerp(h00,h10,u),lerp(h01,h11,u),v);
}
function slopeAt(x,z){const d=terrain.dx;return Math.hypot((groundAt(x+d,z)-groundAt(x-d,z))/(2*d),(groundAt(x,z+d)-groundAt(x,z-d))/(2*d))}

function buildContext(){
  parcelGroup=new THREE.Group();scene.add(parcelGroup);
  const parcel=world.entities().find(e=>e.type==='parcel'||e.subtype==='parcel'); const ring=parcel?world.ringOf(parcel):null;
  if(ring?.length){const pts=ring.map(([x,n])=>new THREE.Vector3(x,groundAt(x,-n)+.55,-n));pts.push(pts[0].clone());const g=new THREE.BufferGeometry().setFromPoints(pts);parcelGroup.add(new THREE.Line(g,new THREE.LineBasicMaterial({color:0xffe36a,transparent:true,opacity:.9})))}
  // Contextual imported roads/water remain lightweight lines; existing access is rebuilt separately as a physical road.
  for(const e of world.entities()){
    if(!e.path||e.id===parcel?.id)continue; if(!['road','path','water','drain'].includes(e.type))continue;
    const color=e.type==='water'?0x70a8c9:0x9b9f96; const pts=e.path.map(([x,n])=>new THREE.Vector3(x,groundAt(x,-n)+.25,-n));
    if(pts.length>1)parcelGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),new THREE.LineBasicMaterial({color,transparent:true,opacity:.42})));
  }
}

function buildRoad(){
  roadGroup=new THREE.Group();scene.add(roadGroup);const path=driveData?.paths?.['drive-main']?.local_m||[];const width=driveData?.paths?.['drive-main']?.width||3.5;
  const roadMat=new THREE.MeshStandardMaterial({color:0xd7d3c4,roughness:1});
  for(let i=1;i<path.length;i++){
    const [ax,an]=path[i-1],[bx,bn]=path[i],az=-an,bz=-bn,dx=bx-ax,dz=bz-az,L=Math.hypot(dx,dz);if(L<.2)continue;
    const mx=(ax+bx)/2,mz=(az+bz)/2,my=(groundAt(ax,az)+groundAt(bx,bz))/2+.07,ang=Math.atan2(dx,dz);
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(width,.12,L+.35),roadMat);mesh.position.set(mx,my,mz);mesh.rotation.y=ang;mesh.receiveShadow=true;roadGroup.add(mesh);
    if(i%2===0){const shape=new Jolt.BoxShape(new Jolt.Vec3(width/2,.06,(L+.35)/2),.02,null);const q=new THREE.Quaternion().setFromAxisAngle(THREE_UP,ang);const cs=new Jolt.BodyCreationSettings(shape,new Jolt.RVec3(mx,my,mz),jq(q),Jolt.EMotionType_Static,LAYER_STATIC);cs.mFriction=1.2;const b=bodyInterface.CreateBody(cs);bodyInterface.AddBody(b.GetID(),Jolt.EActivation_DontActivate);Jolt.destroy(cs)}
  }
}

function mulberry(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function nearDrive(x,z,limit=10){const p=driveData?.paths?.['drive-main']?.local_m||[];for(let i=1;i<p.length;i++){const a=[p[i-1][0],-p[i-1][1]],b=[p[i][0],-p[i][1]],dx=b[0]-a[0],dz=b[1]-a[1],l2=dx*dx+dz*dz||1,t=clamp(((x-a[0])*dx+(z-a[1])*dz)/l2,0,1);if(Math.hypot(x-a[0]-dx*t,z-a[1]-dz*t)<limit)return true}return false}
function buildForest(){
  forestGroup=new THREE.Group();scene.add(forestGroup);const count=mobile?380:1050,r=mulberry(6403);const trunk=new THREE.InstancedMesh(new THREE.CylinderGeometry(.12,.19,1,5),new THREE.MeshStandardMaterial({color:0x3d3328,roughness:1}),count);const crown=new THREE.InstancedMesh(new THREE.ConeGeometry(1,3.7,7),new THREE.MeshStandardMaterial({color:0x233b28,roughness:1}),count);const d=new THREE.Object3D();let n=0;
  for(let tries=0;tries<count*6&&n<count;tries++){
    const x=lerp(terrain.x0,terrain.x1,r()),z=lerp(terrain.z0,terrain.z1,r()); if(slopeAt(x,z)>.78||nearDrive(x,z,7))continue; const y=groundAt(x,z),s=.8+r()*1.35;
    d.position.set(x,y+2.5*s,z);d.scale.set(s,s,s);d.rotation.y=r()*Math.PI*2;d.updateMatrix();crown.setMatrixAt(n,d.matrix); d.position.set(x,y+.9*s,z);d.scale.set(s,s*1.8,s);d.updateMatrix();trunk.setMatrixAt(n,d.matrix);n++;
  }
  crown.count=trunk.count=n;crown.instanceMatrix.needsUpdate=trunk.instanceMatrix.needsUpdate=true;forestGroup.add(trunk,crown); forestGroup.userData.epistemic='SIMULATED VEGETATION';
}

function sitePlacement(){
  const s=siteFit?.best?.[state.siteIndex]||{east_ft:0,north_ft:0,bearing_deg:252,cut_m3:0,fill_m3:0,naturalFall_ft:0};
  return {x:s.east_ft*FT,z:-s.north_ft*FT,bearing:252,raw:s};
}
function buildHenryHouse(){
  if(houseGroup)scene.remove(houseGroup);houseGroup=new THREE.Group();scene.add(houseGroup);const p=sitePlacement(),y=groundAt(p.x,p.z)+.15;
  const mat=new THREE.MeshStandardMaterial({color:0x2b3030,roughness:.76});const glass=new THREE.MeshStandardMaterial({color:0x7ea2ad,roughness:.2,metalness:.05,transparent:true,opacity:.58});const roof=new THREE.MeshStandardMaterial({color:0x171b1c,roughness:.6});
  const addBox=(x0,x1,n0,n1,h,base,material=mat)=>{const w=(x1-x0)*IN,d=(n1-n0)*IN;const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material);m.position.set(((x0+x1)/2)*IN,base+h/2,-((n0+n1)/2)*IN);m.castShadow=!mobile;m.receiveShadow=true;houseGroup.add(m)};
  addBox(BAR.x0,BAR.x1,BAR.y0,BAR.y1,6.1,0); addBox(BAR.x0,BAR.x1,BAR.y0,BAR.y0+5,4.2,2,glass); addBox(LINK.x0,LINK.x1,LINK.y0,LINK.y1,3.5,2.7); addBox(GARAGE.x0,GARAGE.x1,GARAGE.y0,GARAGE.y1,4,2.5);
  const mainRoof=new THREE.Mesh(new THREE.BoxGeometry(72*FT,.28,29*FT),roof);mainRoof.position.set(36*FT,6.5,-13*FT);mainRoof.rotation.z=deg(2.5);houseGroup.add(mainRoof);const gr=new THREE.Mesh(new THREE.BoxGeometry(28*FT,.28,27*FT),roof);gr.position.set(108*FT,6.8,-17*FT);gr.rotation.z=deg(2.5);houseGroup.add(gr);
  houseGroup.position.set(p.x,y,p.z);houseGroup.rotation.y=-deg(p.bearing); updateSiteReadout();
}
function updateSiteReadout(){if(!siteFit)return;const p=sitePlacement(),s=p.raw;$('siteReadout').textContent=`SITE ${state.siteIndex+1}/${siteFit.best.length} · house 252° · cut ${Math.round(s.cut_m3||0)} m³ · fill ${Math.round(s.fill_m3||0)} m³ · natural fall ${(s.naturalFall_ft||0).toFixed(1)} ft`}

function createVehicle(){
  const path=driveData.paths['drive-main'].local_m;const a=path[0],b=path[Math.min(2,path.length-1)],x=a[0],z=-a[1],dx=b[0]-a[0],dz=-b[1]+a[1],heading=Math.atan2(dx,dz),y=groundAt(x,z)+2.1;
  const halfW=.93,halfH=.28,halfL=2.05,wheelR=.42,wheelWidth=.26;
  const shapeSettings=new Jolt.OffsetCenterOfMassShapeSettings(new Jolt.Vec3(0,-.32,0),new Jolt.BoxShapeSettings(new Jolt.Vec3(halfW,halfH,halfL)));const shape=shapeSettings.Create().Get();
  const rot=new THREE.Quaternion().setFromAxisAngle(THREE_UP,heading);const cs=new Jolt.BodyCreationSettings(shape,new Jolt.RVec3(x,y,z),jq(rot),Jolt.EMotionType_Dynamic,LAYER_MOVING);cs.mOverrideMassProperties=Jolt.EOverrideMassProperties_CalculateInertia;cs.mMassPropertiesOverride.mMass=1850;cs.mFriction=.9;carBody=bodyInterface.CreateBody(cs);bodyInterface.AddBody(carBody.GetID(),Jolt.EActivation_Activate);Jolt.destroy(cs);
  const vs=new Jolt.VehicleConstraintSettings();vs.mMaxPitchRollAngle=deg(72);vs.mWheels.clear();const wheelPos=[[halfW,-.25,1.35],[-halfW,-.25,1.35],[halfW,-.25,-1.35],[-halfW,-.25,-1.35]];const wset=[];
  wheelPos.forEach((p,i)=>{const w=new Jolt.WheelSettingsWV();w.mPosition=new Jolt.Vec3(...p);w.mRadius=wheelR;w.mWidth=wheelWidth;w.mSuspensionMinLength=.18;w.mSuspensionMaxLength=.58;w.mMaxSteerAngle=i<2?deg(31):0;w.mMaxHandBrakeTorque=i<2?0:5000;vs.mWheels.push_back(w);wset.push(w)});
  const ctl=new Jolt.WheeledVehicleControllerSettings();ctl.mEngine.mMaxTorque=760;ctl.mEngine.mMinRPM=700;ctl.mEngine.mMaxRPM=6200;ctl.mTransmission.mClutchStrength=12;ctl.mDifferentials.clear();
  [[0,1],[2,3]].forEach(pair=>{const d=new Jolt.VehicleDifferentialSettings();d.mLeftWheel=pair[0];d.mRightWheel=pair[1];d.mEngineTorqueRatio=.5;d.mLimitedSlipRatio=1.7;ctl.mDifferentials.push_back(d)});ctl.mDifferentialLimitedSlipRatio=1.5;vs.mController=ctl;
  const ar1=new Jolt.VehicleAntiRollBar();ar1.mLeftWheel=0;ar1.mRightWheel=1;const ar2=new Jolt.VehicleAntiRollBar();ar2.mLeftWheel=2;ar2.mRightWheel=3;vs.mAntiRollBars.clear();vs.mAntiRollBars.push_back(ar1);vs.mAntiRollBars.push_back(ar2);
  carConstraint=new Jolt.VehicleConstraint(carBody,vs);carConstraint.SetVehicleCollisionTester(new Jolt.VehicleCollisionTesterCastCylinder(LAYER_MOVING,.08));physicsSystem.AddConstraint(carConstraint);carController=Jolt.castObject(carConstraint.GetController(),Jolt.WheeledVehicleController);
  car=new THREE.Group();const bodyMat=new THREE.MeshStandardMaterial({color:0xd85b27,roughness:.6,metalness:.15});const dark=new THREE.MeshStandardMaterial({color:0x171a17,roughness:.8});const body=new THREE.Mesh(new THREE.BoxGeometry(1.86,.62,4.1),bodyMat);body.position.y=.35;body.castShadow=!mobile;car.add(body);const cab=new THREE.Mesh(new THREE.BoxGeometry(1.72,.72,1.85),dark);cab.position.set(0,.92,-.25);car.add(cab);
  wheelMeshes=[];for(let i=0;i<4;i++){const m=new THREE.Mesh(new THREE.CylinderGeometry(wheelR,wheelR,wheelWidth,16),dark);m.rotation.z=Math.PI/2;car.add(m);wheelMeshes.push(m)}scene.add(car);lastCarPos.set(x,y,z);
}

function updateVehicleInput(){
  let f=state.input.forward,s=state.input.steer,h=state.input.handbrake?1:0,b=0; const q=tq(carBody.GetRotation()).invert(),v=tv(carBody.GetLinearVelocity()).applyQuaternion(q).z;
  if(f&&Math.sign(f)!==Math.sign(v)&&Math.abs(v)>1.2){b=1;f=0} carController.SetDriverInput(f,s,b,h); if(f||s||b||h)bodyInterface.ActivateBody(carBody.GetID());
}
function updateVehicleVisual(){
  const p=tv(carBody.GetPosition()),q=tq(carBody.GetRotation());car.position.copy(p);car.quaternion.copy(q);const right=new Jolt.Vec3(0,1,0),up=new Jolt.Vec3(1,0,0);
  wheelMeshes.forEach((m,i)=>{const t=carConstraint.GetWheelLocalTransform(i,right,up);m.position.copy(tv(t.GetTranslation()));m.quaternion.copy(tq(t.GetRotation().GetQuaternion()))});
  const mph=tv(carBody.GetLinearVelocity()).length()*2.23694;$('speed').textContent=Math.round(mph);const forward=new THREE.Vector3(0,0,1).applyQuaternion(q),p0=p.clone(),p1=p.clone().addScaledVector(forward,3);const g=(groundAt(p1.x,p1.z)-groundAt(p0.x,p0.z))/3;$('grade').textContent=`${Math.round(g*100)}%`;
}
function recover(){if(!carBody)return;const p=tv(carBody.GetPosition());const y=groundAt(p.x,p.z)+2.2;bodyInterface.SetPositionAndRotation(carBody.GetID(),new Jolt.RVec3(p.x,y,p.z),Jolt.Quat.prototype.sIdentity(),Jolt.EActivation_Activate);bodyInterface.SetLinearVelocity(carBody.GetID(),new Jolt.Vec3(0,0,0));bodyInterface.SetAngularVelocity(carBody.GetID(),new Jolt.Vec3(0,0,0));toast('vehicle recovered')}

function updateCamera(dt){
  if(state.mode==='map')return; const p=car.position,q=car.quaternion;
  let local;if(state.cameraMode===0)local=new THREE.Vector3(0,4.2,-9.2);else if(state.cameraMode===1)local=new THREE.Vector3(0,1.65,1.15);else local=new THREE.Vector3(0,12,-18);
  const desired=p.clone().add(local.applyQuaternion(q)),target=p.clone().add(new THREE.Vector3(0,1.1,2.6).applyQuaternion(q));const t=1-Math.exp(-dt*(state.cameraMode===1?12:5));camera.position.lerp(desired,t);camera.up.lerp(THREE_UP,.1);camera.lookAt(target);
}
function enterMap(){const b=world.place.bounds();const cx=(b[0]+b[2])/2,n=(b[1]+b[3])/2,span=Math.max(b[2]-b[0],b[3]-b[1]);camera.position.set(cx,Math.max(300,span*.82),-n+.01);camera.up.set(0,0,-1);camera.lookAt(cx,0,-n);camera.fov=48;camera.updateProjectionMatrix()}

function aimGround(){raycaster.setFromCamera(new THREE.Vector2(0,0),camera);const hit=raycaster.intersectObject(terrainMesh,false)[0];if(!hit)return null;return hit.point.clone()}
function updateTarget(){if(state.mode!=='build')return;state.target=aimGround();if(state.target)$('targetReadout').textContent=`${state.target.x.toFixed(1)} E · ${(-state.target.z).toFixed(1)} N · slope ${Math.round(slopeAt(state.target.x,state.target.z)*100)}%`}

function clearGhost(){ghostGroup.clear();state.ghost=null;$('ghostActions').hidden=true}
function primitiveProposal(prompt=''){const size=state.footprint==='large'?[24,14]:state.footprint==='small'?[12,8]:[8,6];const [w,d]=size;return {name:'FIELD PAVILION',primitives:[{type:'deck',x:0,z:0,w,d,h:.35,y:1.2,yaw:0},{type:'column',x:-w*.42,z:-d*.38,w:.35,d:.35,h:4.2,y:1.2,yaw:0},{type:'column',x:w*.42,z:-d*.38,w:.35,d:.35,h:4.2,y:1.2,yaw:0},{type:'column',x:-w*.42,z:d*.38,w:.35,d:.35,h:4.2,y:1.2,yaw:0},{type:'column',x:w*.42,z:d*.38,w:.35,d:.35,h:4.2,y:1.2,yaw:0},{type:'roof',x:0,z:0,w:w+2,d:d+2,h:.28,y:5.5,yaw:0,pitch:5},{type:'ramp',x:0,z:d*.72,w:3,d:8,h:.35,y:1.1,yaw:0,pitch:-11}],note:prompt||'deterministic pavilion'} }
function validateProposal(p){
  if(!p||!Array.isArray(p.primitives))throw Error('proposal has no primitives');if(p.primitives.length>40)throw Error('proposal too complex');const allowed=new Set(['box','wall','column','deck','roof','ramp']);
  p.primitives=p.primitives.map(o=>({type:allowed.has(o.type)?o.type:'box',x:clamp(+o.x||0,-35,35),z:clamp(+o.z||0,-35,35),w:clamp(+o.w||1,.15,30),d:clamp(+o.d||1,.15,30),h:clamp(+o.h||1,.12,16),y:clamp(+o.y||0,0,18),yaw:clamp(+o.yaw||0,-180,180),pitch:clamp(+o.pitch||0,-25,25)}));return p;
}
function showGhost(proposal){clearGhost();if(!state.target)throw Error('aim at ground first');proposal=validateProposal(proposal);const mat=new THREE.MeshBasicMaterial({color:0x6cf5e3,wireframe:true,transparent:true,opacity:.85});
  for(const o of proposal.primitives){const m=new THREE.Mesh(new THREE.BoxGeometry(o.w,o.h,o.d),mat);const gy=groundAt(state.target.x+o.x,state.target.z+o.z);m.position.set(state.target.x+o.x,gy+o.y+o.h/2,state.target.z+o.z);m.rotation.y=deg(o.yaw);m.rotation.x=deg(o.pitch);ghostGroup.add(m)}state.ghost={proposal,target:state.target.clone()};$('ghostActions').hidden=false;toast(`${proposal.name||'proposal'} · ghost only`)}
function commitGhost(){if(!state.ghost)return;const mat=new THREE.MeshStandardMaterial({color:0x7a6044,roughness:.82});for(const o of state.ghost.proposal.primitives){const x=state.ghost.target.x+o.x,z=state.ghost.target.z+o.z,gy=groundAt(x,z),y=gy+o.y+o.h/2,q=new THREE.Quaternion().setFromEuler(new THREE.Euler(deg(o.pitch),deg(o.yaw),0));const mesh=new THREE.Mesh(new THREE.BoxGeometry(o.w,o.h,o.d),mat);mesh.position.set(x,y,z);mesh.quaternion.copy(q);mesh.castShadow=!mobile;mesh.receiveShadow=true;builtGroup.add(mesh);const shape=new Jolt.BoxShape(new Jolt.Vec3(o.w/2,o.h/2,o.d/2),.03,null);const cs=new Jolt.BodyCreationSettings(shape,new Jolt.RVec3(x,y,z),jq(q),Jolt.EMotionType_Static,LAYER_STATIC);cs.mFriction=.85;const b=bodyInterface.CreateBody(cs);bodyInterface.AddBody(b.GetID(),Jolt.EActivation_DontActivate);Jolt.destroy(cs)}clearGhost();setMode('drive');toast('structure is now physical')}

async function aiProposal(){
  const key=$('apiKey').value.trim()||state.key;if(!key){openWorld();toast('enter an API key in WORLD');return}if(!state.target){toast('aim at ground');return}const prompt=$('buildPrompt').value.trim();if(!prompt){toast('describe what to build');return}
  $('aiBuild').disabled=true;$('aiBuild').textContent='THINKING';
  const slope=Math.round(slopeAt(state.target.x,state.target.z)*100);const schema={type:'object',additionalProperties:false,required:['name','primitives','note'],properties:{name:{type:'string'},note:{type:'string'},primitives:{type:'array',minItems:1,maxItems:30,items:{type:'object',additionalProperties:false,required:['type','x','z','w','d','h','y','yaw','pitch'],properties:{type:{type:'string',enum:['box','wall','column','deck','roof','ramp']},x:{type:'number'},z:{type:'number'},w:{type:'number'},d:{type:'number'},h:{type:'number'},y:{type:'number'},yaw:{type:'number'},pitch:{type:'number'}}}}}};
  const instructions=`You are the CREO-UNSET world compiler. Design PLAYABLE structures from bounded box/ramp primitives. Coordinates are metres relative to the player's target. Preserve a driveable route, vehicle width 2 m, clearance 2.8 m. Ramps must be <= 18 degrees. Prefer one strong silhouette. Return a proposal only; never code.`;
  try{
    const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},body:JSON.stringify({model:$('modelName').value.trim()||'gpt-5.1',instructions,input:`PLAYER REQUEST: ${prompt}\nSITE: local slope ${slope}%, target E ${state.target.x.toFixed(1)} N ${(-state.target.z).toFixed(1)}. Existing access must remain clear.`,text:{format:{type:'json_schema',name:'creo_build',strict:true,schema}}})});
    const data=await r.json();if(!r.ok)throw Error(data?.error?.message||`API ${r.status}`);let text=data.output_text;if(!text){for(const item of data.output||[])for(const c of item.content||[])if(c.type==='output_text')text=c.text}if(!text)throw Error('model returned no proposal');showGhost(JSON.parse(text));state.key=key;
  }catch(err){console.error(err);toast(err.message||'AI failed')}finally{$('aiBuild').disabled=false;$('aiBuild').textContent='AI GHOST'}
}

function setupUI(){
  document.querySelectorAll('#dock button').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));
  document.querySelectorAll('.closeSheet').forEach(b=>b.addEventListener('click',()=>setMode('drive')));
  document.querySelectorAll('[data-footprint]').forEach(b=>b.addEventListener('click',()=>{state.footprint=b.dataset.footprint;document.querySelectorAll('[data-footprint]').forEach(x=>x.classList.toggle('on',x===b))}));
  $('basicBuild').addEventListener('click',()=>{if(!state.target)state.target=aimGround();showGhost(primitiveProposal($('buildPrompt').value))});$('aiBuild').addEventListener('click',aiProposal);$('rejectGhost').addEventListener('click',clearGhost);$('commitGhost').addEventListener('click',commitGhost);
  $('sitePrev').addEventListener('click',()=>{state.siteIndex=(state.siteIndex-1+siteFit.best.length)%siteFit.best.length;buildHenryHouse()});$('siteNext').addEventListener('click',()=>{state.siteIndex=(state.siteIndex+1)%siteFit.best.length;buildHenryHouse()});
  $('treesToggle').addEventListener('change',e=>forestGroup.visible=e.target.checked);$('driveToggle').addEventListener('change',e=>roadGroup.visible=e.target.checked);$('parcelToggle').addEventListener('change',e=>parcelGroup.visible=e.target.checked);$('houseToggle').addEventListener('change',e=>houseGroup.visible=e.target.checked);
  addEventListener('keydown',e=>{if(e.target.matches('input,textarea'))return;const k=e.key.toLowerCase();if(k==='w'||k==='arrowup')state.input.forward=1;if(k==='s'||k==='arrowdown')state.input.forward=-1;if(k==='a'||k==='arrowleft')state.input.steer=-1;if(k==='d'||k==='arrowright')state.input.steer=1;if(e.code==='Space')state.input.handbrake=true;if(k==='c'){state.cameraMode=(state.cameraMode+1)%3;toast(['CHASE','HOOD','HIGH CHASE'][state.cameraMode])}if(k==='m')setMode(state.mode==='map'?'drive':'map');if(k==='b')setMode('build');if(k==='r')recover()});
  addEventListener('keyup',e=>{const k=e.key.toLowerCase();if(['w','s','arrowup','arrowdown'].includes(k))state.input.forward=0;if(['a','d','arrowleft','arrowright'].includes(k))state.input.steer=0;if(e.code==='Space')state.input.handbrake=false});
  setupStick(); $('handbrake').addEventListener('pointerdown',e=>{e.preventDefault();state.input.handbrake=true});['pointerup','pointercancel','pointerleave'].forEach(ev=>$('handbrake').addEventListener(ev,()=>state.input.handbrake=false));
}
function setupStick(){const zone=$('stickZone'),stick=$('stick');let active=false,pid=null;const move=e=>{if(!active||e.pointerId!==pid)return;const r=zone.getBoundingClientRect(),dx=e.clientX-(r.left+r.width/2),dy=e.clientY-(r.top+r.height/2),lim=r.width*.34,L=Math.hypot(dx,dy)||1,k=Math.min(1,lim/L),x=dx*k,y=dy*k;stick.style.transform=`translate(${x}px,${y}px)`;state.input.steer=clamp(x/lim,-1,1);state.input.forward=clamp(-y/lim,-1,1)};zone.addEventListener('pointerdown',e=>{active=true;pid=e.pointerId;zone.setPointerCapture(pid);move(e)});zone.addEventListener('pointermove',move);const end=e=>{if(e.pointerId!==pid)return;active=false;pid=null;stick.style.transform='translate(0,0)';state.input.steer=state.input.forward=0};zone.addEventListener('pointerup',end);zone.addEventListener('pointercancel',end)}

function animate(){requestAnimationFrame(animate);let dt=Math.min(clock.getDelta(),1/30);if(state.mode!=='map'&&carController)updateVehicleInput();jolt.Step(dt,dt>1/55?2:1);updateVehicleVisual();updateCamera(dt);updateTarget();renderer.render(scene,camera)}

boot();
