const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function bytesFromB64(s){const bin=atob(s),out=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);return out}
function decodeTerrain(t){
  const bytes=bytesFromB64(t.f32), src=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4);
  const [x0,y0,x1,y1]=t.bounds,cell=t.cell,nx=Math.max(2,Math.round((x1-x0)/cell)+1),ny=Math.max(2,Math.round((y1-y0)/cell)+1);
  const at=(i,j)=>src[clamp(j,0,ny-1)*nx+clamp(i,0,nx-1)];
  const h=(x,y)=>{const fx=(x-x0)/cell,fy=(y-y0)/cell,i=Math.floor(fx),j=Math.floor(fy),u=fx-i,v=fy-j,h00=at(i,j),h10=at(i+1,j),h11=at(i+1,j+1),h01=at(i,j+1);return v<=u?h00+(h10-h00)*u+(h11-h10)*v:h00+(h11-h01)*u+(h01-h00)*v};
  return {bounds:t.bounds,heightAt:h};
}
self.onmessage=async e=>{
  try{
    const {url,detail=false}=e.data||{};
    self.postMessage({stage:'fetch'});
    const r=await fetch(url,{cache:'force-cache'});if(!r.ok)throw Error(`CREO place ${r.status}`);
    const text=await r.text();self.postMessage({stage:'parse',bytes:text.length});
    const saved=JSON.parse(text),p=saved.place;if(!p?.terrain)throw Error('saved CREO place has no terrain');
    const hf=decodeTerrain(p.terrain),N=detail?129:65,[x0,n0,x1,n1]=hf.bounds,heights=new Float32Array(N*N),dx=(x1-x0)/(N-1),dn=(n1-n0)/(N-1);
    let lo=Infinity,hi=-Infinity;
    for(let j=0;j<N;j++)for(let i=0;i<N;i++){const z=hf.heightAt(x0+i*dx,n0+j*dn),k=j*N+i;heights[k]=z;lo=Math.min(lo,z);hi=Math.max(hi,z)}
    const datum=Math.floor(lo/10)*10;for(let i=0;i<heights.length;i++)heights[i]-=datum;
    const keep=new Set(['parcel','road','path','water','drain']);
    const entities=(p.entities||[]).filter(o=>keep.has(o.type)||o.subtype==='parcel').map(o=>({id:o.id,type:o.type,subtype:o.subtype||null,name:o.name||null,width:o.width||null,footprint:o.footprint||null,path:o.path||null}));
    self.postMessage({stage:'done',terrain:{bounds:hf.bounds,N,heights,datum,lo:lo-datum,hi:hi-datum},entities,meta:{id:p.id,name:p.name,anchor:p.anchor}},[heights.buffer]);
  }catch(err){self.postMessage({stage:'error',error:String(err?.message||err)})}
};
